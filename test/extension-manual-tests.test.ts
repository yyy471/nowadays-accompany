import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/core/core.js';
import { silentLogger } from '../src/core/logger.js';
import { FakeProviderAdapter } from '../src/providers/adapters/fake.js';
import { createTestCore } from './helpers.js';
import { accountPolicy, bind, fakeProvider, waitFor, writePhase1Config } from './phase1-helpers.js';

const roots: string[] = [];
const cores: Core[] = [];
const markerEnvKey = 'ACCOMPANY_MANUAL_TEST_MARKER';
let savedMarker: string | undefined;

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
  if (savedMarker !== undefined) process.env[markerEnvKey] = savedMarker;
  else delete process.env[markerEnvKey];
});

const WEATHER_PLUGIN = 'public/plugin/weather';
const WEATHER_TOOL = 'public/plugin/weather/query';
const TRAVEL_SKILL = 'travel-planning';
const PLUGIN_SKILL = 'public/plugin/weather/skill/forecast';
const MODEL_TOOL = 'p_public_weather_query';

async function setup(options: { fake?: Record<string, unknown>; authorized?: boolean; supportsTools?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-extension-manual-'));
  roots.push(root);
  const fake = new FakeProviderAdapter();
  await writePhase1Config(root, {
    providers: [
      fakeProvider('fake-chat', options.fake ?? {}, {
        models: [{
          id: 'tool-model',
          capabilities: ['chat', 'image.generate', 'audio.generate'],
          input: ['text'],
          supportsTools: options.supportsTools ?? true
        }]
      })
    ],
    accountPolicies: {
      '10001': accountPolicy({
        allowedProviders: ['fake-chat'],
        bindings: {
          chat: bind('fake-chat', 'tool-model'),
          'image.generate': bind('fake-chat', 'tool-model'),
          'audio.generate': bind('fake-chat', 'tool-model')
        }
      }),
      '10002': accountPolicy({
        allowedProviders: ['fake-chat'],
        bindings: {
          chat: bind('fake-chat', 'tool-model'),
          'image.generate': bind('fake-chat', 'tool-model'),
          'audio.generate': bind('fake-chat', 'tool-model')
        }
      }),
      '10003': accountPolicy({
        allowedProviders: ['fake-chat'],
        bindings: {
          chat: bind('fake-chat', 'tool-model'),
          'image.generate': bind('fake-chat', 'tool-model'),
          'audio.generate': bind('fake-chat', 'tool-model')
        }
      })
    }
  });
  const core = await createTestCore({
    dataRoot: root,
    instances: [],
    api: { enabled: true, port: 0, token: 'extension-manual-fixture' },
    providerAdapters: [fake],
    logger: silentLogger()
  }, ['10001', '10002', '10003']);
  cores.push(core);
  await core.start();
  const base = core.status().apiUrl!;
  const headers = { authorization: 'Bearer extension-manual-fixture', 'content-type': 'application/json' };

  await importPackage(root, base, headers, 'plugins', 'weather', path.join(process.cwd(), 'examples', 'extensions', 'weather'));
  const publicSkills = core.listPublicSkills();
  const skillImport = await request(base, headers, '/extensions/imports', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'skill',
      sourceDirectory: path.join(process.cwd(), 'examples', 'extensions', 'travel-planning'),
      target: { source: 'public' },
      expectedRevision: publicSkills.revision
    })
  });
  expect(skillImport.status).toBe(200);

  for (const accountId of ['10001', '10002', '10003']) {
    await core.saveAccountProfile(accountId, {
      version: 1,
      roleCard: { source: 'public', id: 'default', revision: 'r1' },
      plugins: [{ source: 'public', id: 'weather', revision: 'r1', enabled: true }]
    });
  }
  if (options.authorized !== false) {
    await grant(core, '10001', [WEATHER_TOOL, 'builtin.image.generate'], [TRAVEL_SKILL]);
    await grant(core, '10002', [WEATHER_TOOL], [TRAVEL_SKILL]);
  }
  return { core, fake, base, headers, root };
}

async function importPackage(
  root: string,
  base: string,
  headers: Record<string, string>,
  kind: 'plugins' | 'skills',
  name: string,
  sourceDirectory: string
): Promise<void> {
  const destination = path.join(root, 'imports', kind, name);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(sourceDirectory, destination, { recursive: true });
  if (kind !== 'plugins') return;
  const imported = await request(base, headers, '/extensions/imports', {
    method: 'POST',
    body: JSON.stringify({ kind: 'plugin', sourceDirectory: destination, target: { source: 'public' } })
  });
  if (imported.status !== 200) throw new Error(`plugin import failed: ${imported.status} ${JSON.stringify(imported.body)}`);
}

async function writeLocalPlugin(root: string, name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(root, 'imports', 'plugins', name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(dir, file), content, 'utf8');
  return dir;
}

function pluginManifest(id: string): string {
  return `${JSON.stringify({
    id,
    kind: 'plugin',
    revision: 'r1',
    entry: 'index.mjs',
    apiVersion: 1,
    tools: [{
      id: 'run',
      description: 'Offline fixture tool.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: 'read'
    }]
  }, null, 2)}\n`;
}

async function grant(core: Core, accountId: string, tools: string[], skills: string[]): Promise<void> {
  const view = await core.getExtensionPolicy(accountId);
  const pluginSwitches: Record<string, 'on'> = {};
  for (const tool of tools) {
    const match = /^(public|private)\/plugin\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/[^/]+$/.exec(tool);
    if (match) pluginSwitches[`${match[1]}/plugin/${match[2]}`] = 'on';
  }
  await core.updateExtensionPolicy(accountId, {
    expectedRevision: view.revision,
    expectedProfileRevision: view.profileRevision,
    patch: {
      authorizedTools: tools,
      defaults: {
        ...(Object.keys(pluginSwitches).length > 0 ? { plugins: pluginSwitches } : {}),
        tools: Object.fromEntries(tools.map((tool) => [tool, 'on' as const])),
        ...(skills.length > 0 ? { skills: Object.fromEntries(skills.map((skill) => [skill, 'on' as const])) } : {})
      }
    }
  });
}

async function request(base: string, headers: Record<string, string>, pathname: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${pathname}`, { ...init, headers });
  return { status: response.status, body: await response.json() as any };
}

async function savePluginConfig(
  base: string,
  headers: Record<string, string>,
  accountId: string,
  config: Record<string, unknown>
): Promise<void> {
  const pathname = `/accounts/${accountId}/extensions/config?kind=plugin&id=${encodeURIComponent(WEATHER_PLUGIN)}`;
  const current = await request(base, headers, pathname);
  expect(current.status).toBe(200);
  const saved = await request(base, headers, pathname, {
    method: 'PUT',
    body: JSON.stringify({ config, expectedRevision: current.body.revision })
  });
  expect(saved.status).toBe(200);
}

async function saveSkillConfig(
  base: string,
  headers: Record<string, string>,
  accountId: string,
  config: Record<string, unknown>,
  skillId = TRAVEL_SKILL
): Promise<void> {
  const pathname = `/accounts/${accountId}/extensions/config?kind=skill&id=${encodeURIComponent(skillId)}`;
  const current = await request(base, headers, pathname);
  expect(current.status).toBe(200);
  const saved = await request(base, headers, pathname, {
    method: 'PUT',
    body: JSON.stringify({ config, expectedRevision: current.body.revision })
  });
  expect(saved.status).toBe(200);
}

async function testTool(
  base: string,
  headers: Record<string, string>,
  accountId: string,
  toolId: string,
  args: Record<string, unknown> = {}
) {
  return request(base, headers, `/accounts/${accountId}/extensions/tests/tool`, {
    method: 'POST',
    body: JSON.stringify({ toolId, arguments: args })
  });
}

async function testSkill(
  base: string,
  headers: Record<string, string>,
  accountId: string,
  input: string,
  skillId = TRAVEL_SKILL
) {
  return request(base, headers, `/accounts/${accountId}/extensions/tests/skill`, {
    method: 'POST',
    body: JSON.stringify({ skillId, input })
  });
}

describe('manual tool tests', () => {
  it('runs the selected plugin with the account config, without a model call or production state', async () => {
    const { core, fake, base, headers, root } = await setup();
    await savePluginConfig(base, headers, '10001', { city: '杭州' });
    await savePluginConfig(base, headers, '10002', { city: '上海' });

    const chatCallsBefore = fake.calls.filter((call) => call.capability === 'chat').length;
    const first = await testTool(base, headers, '10001', WEATHER_TOOL);
    expect(first.status).toBe(200);
    expect(first.body.test).toMatchObject({
      status: 'ok',
      delivery: 'skipped',
      tools: [WEATHER_TOOL],
      calls: [expect.objectContaining({ toolId: WEATHER_TOOL, result: expect.objectContaining({ status: 'ok' }) })]
    });
    expect(first.body.test.calls[0].result.text).toContain('杭州');
    const second = await testTool(base, headers, '10002', WEATHER_TOOL);
    expect(second.body.test.calls[0].result.text).toContain('上海');
    expect(fake.calls.filter((call) => call.capability === 'chat').length).toBe(chatCallsBefore);

    await expect(fs.access(path.join(root, 'accounts', '10001', 'plugin-state'))).rejects.toThrow();
    const testRuns = path.join(root, 'test-runs');
    const remaining = await fs.readdir(testRuns).catch(() => []);
    expect(remaining).toEqual([]);
    await expect(fs.access(path.join(root, 'accounts', '10001', 'state', 'tool-invocations.json'))).rejects.toThrow();
    await expect(fs.access(path.join(root, 'accounts', '10001', 'messages'))).rejects.toThrow();

    await core.stop();
    cores.splice(cores.indexOf(core), 1);
    const restarted = await createCore({
      dataRoot: root,
      instances: [],
      api: { enabled: true, port: 0, token: 'extension-manual-fixture' },
      providerAdapters: [new FakeProviderAdapter()],
      logger: silentLogger()
    });
    cores.push(restarted);
    await restarted.start();
    const restartedBase = restarted.status().apiUrl!;
    const restartedHeaders = { authorization: 'Bearer extension-manual-fixture', 'content-type': 'application/json' };
    const afterRestart = await testTool(restartedBase, restartedHeaders, '10001', WEATHER_TOOL);
    expect(afterRestart.body.test.calls[0].result.text).toContain('杭州');
  });

  it('accepts a valid JSON object with business fields the author must interpret', async () => {
    const { base, headers } = await setup();
    await savePluginConfig(base, headers, '10001', { city: 42 });
    const tested = await testTool(base, headers, '10001', WEATHER_TOOL);
    expect(tested.status).toBe(200);
    expect(tested.body.test).toMatchObject({ status: 'ok', delivery: 'skipped' });
    expect(tested.body.test.calls[0].result.text).toContain('42');
  });

  it('releases an active test worker and its temporary state when Core stops', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-extension-stop-'));
    roots.push(root);
    const core = await createTestCore({ dataRoot: root, instances: [], logger: silentLogger() }, ['10001']);
    cores.push(core);
    await core.start();
    const dir = await writeLocalPlugin(root, 'hang', {
      'manifest.json': pluginManifest('hang'),
      'index.mjs': 'export const tools = { run: async () => { await new Promise((resolve) => setTimeout(resolve, 30_000)); return { status: "ok" }; } };\n'
    });
    await core.importExtension({ kind: 'plugin', sourceDirectory: dir, target: { source: 'public' } });
    await core.saveAccountProfile('10001', {
      version: 1,
      plugins: [{ source: 'public', id: 'hang', revision: 'r1', enabled: true }]
    });
    const view = await core.getExtensionPolicy('10001');
    await core.updateExtensionPolicy('10001', {
      expectedRevision: view.revision,
      expectedProfileRevision: view.profileRevision,
      patch: {
        authorizedTools: ['public/plugin/hang/run'],
        defaults: {
          plugins: { 'public/plugin/hang': 'on' },
          tools: { 'public/plugin/hang/run': 'on' }
        }
      }
    });

    const pending = core.testExtensionTool('10001', { toolId: 'public/plugin/hang/run', arguments: {} });
    const testRuns = path.join(root, 'test-runs');
    await waitFor(async () => (await fs.readdir(testRuns).catch(() => [])).length === 1, 5_000);
    const stoppedAt = Date.now();
    await core.stop();
    cores.splice(cores.indexOf(core), 1);
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    const outcome = await pending.then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    if ('error' in outcome) expect(outcome.error).toMatchObject({ code: 'extension_test_closed' });
    else expect(outcome.result.status).toBe('error');
    expect(await fs.readdir(testRuns).catch(() => [])).toEqual([]);
  }, 15_000);

  it('reports unauthorized tools and Skills without granting access', async () => {
    const { core, base, headers } = await setup({ authorized: false });
    const tool = await testTool(base, headers, '10001', WEATHER_TOOL);
    expect(tool.status).toBe(200);
    expect(tool.body.test).toMatchObject({ status: 'error', stage: 'load' });
    expect(['plugin_switch_off', 'switch_off', 'unauthorized', 'tool_not_authorized']).toContain(tool.body.test.code);

    const preview = await request(base, headers, '/accounts/10001/extensions/tests/skill-preview', {
      method: 'POST',
      body: JSON.stringify({ skillId: TRAVEL_SKILL, input: '帮我安排明天的杭州一日游' })
    });
    expect(preview.status).toBe(200);
    expect(preview.body.preview.skill.enabled).toBe(false);
    expect(preview.body.preview.skill.unavailableTools).toContain(WEATHER_TOOL);
    expect(preview.body.preview.tools.find((entry: { id: string }) => entry.id === WEATHER_TOOL)).toMatchObject({
      available: false,
      handlerStatus: 'unverified'
    });

    const view = await core.getExtensionPolicy('10001');
    expect(view.authorizedTools).toEqual([]);
  });

  it('does not execute the target or an unrelated plugin until the requested tool is allowed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-extension-r1-'));
    roots.push(root);
    const core = await createTestCore({ dataRoot: root, instances: [], logger: silentLogger() }, ['10001']);
    cores.push(core);
    await core.start();
    const targetMarker = path.join(root, 'target-loaded');
    const unrelatedMarker = path.join(root, 'unrelated-loaded');
    const writeMarkerPlugin = async (id: string, marker: string): Promise<string> => {
      return writeLocalPlugin(root, id, {
        'manifest.json': pluginManifest(id),
        'index.mjs': [
          "import fs from 'node:fs';",
          `fs.writeFileSync(${JSON.stringify(marker)}, "loaded");`,
          'export const tools = { run: async () => ({ status: "ok", text: "marker" }) };'
        ].join('\n')
      });
    };
    const targetDirectory = await writeMarkerPlugin('r1-target', targetMarker);
    const unrelatedDirectory = await writeMarkerPlugin('r1-unrelated', unrelatedMarker);
    for (const directory of [targetDirectory, unrelatedDirectory]) {
      await core.importExtension({ kind: 'plugin', sourceDirectory: directory, target: { source: 'public' } });
    }
    await core.saveAccountProfile('10001', {
      version: 1,
      plugins: [
        { source: 'public', id: 'r1-target', revision: 'r1', enabled: true },
        { source: 'public', id: 'r1-unrelated', revision: 'r1', enabled: true }
      ]
    });

    const denied = await core.testExtensionTool('10001', {
      toolId: 'public/plugin/r1-target/run',
      arguments: {}
    });
    expect(denied).toMatchObject({ status: 'error', stage: 'load', calls: [] });
    await expect(fs.access(targetMarker)).rejects.toThrow();
    await expect(fs.access(unrelatedMarker)).rejects.toThrow();

    await grant(core, '10001', ['public/plugin/r1-target/run'], []);
    const allowed = await core.testExtensionTool('10001', {
      toolId: 'public/plugin/r1-target/run',
      arguments: {}
    });
    expect(allowed).toMatchObject({ status: 'ok', calls: [expect.objectContaining({ toolId: 'public/plugin/r1-target/run' })] });
    expect(await fs.readFile(targetMarker, 'utf8')).toBe('loaded');
    await expect(fs.access(unrelatedMarker)).rejects.toThrow();
  });

  it('shares the existing per-account tool budget across concurrent manual tests', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-extension-r2-'));
    roots.push(root);
    const core = await createTestCore({ dataRoot: root, instances: [], logger: silentLogger() }, ['10001']);
    cores.push(core);
    await core.start();
    const directory = await writeLocalPlugin(root, 'slow-concurrent', {
      'manifest.json': pluginManifest('slow-concurrent'),
      'index.mjs': [
        'export const tools = { run: async () => {',
        '  const start = Date.now();',
        '  await new Promise((resolve) => setTimeout(resolve, 250));',
        '  return { status: "ok", data: { start, end: Date.now() }, text: "slow" };',
        '} };'
      ].join('\n')
    });
    await core.importExtension({ kind: 'plugin', sourceDirectory: directory, target: { source: 'public' } });
    await core.saveAccountProfile('10001', {
      version: 1,
      plugins: [{ source: 'public', id: 'slow-concurrent', revision: 'r1', enabled: true }]
    });
    await grant(core, '10001', ['public/plugin/slow-concurrent/run'], []);

    const results = await Promise.all(Array.from({ length: 5 }, () =>
      core.testExtensionTool('10001', { toolId: 'public/plugin/slow-concurrent/run', arguments: {} })
    ));
    expect(results.every((result) => result.status === 'ok')).toBe(true);
    const intervals = results.map((result) => result.calls[0]!.result.data as { start: number; end: number });
    let running = 0;
    let maximum = 0;
    for (const event of intervals
      .flatMap((interval) => [{ at: interval.start, delta: 1 }, { at: interval.end, delta: -1 }])
      .sort((left, right) => left.at - right.at || left.delta - right.delta)) {
      running += event.delta;
      maximum = Math.max(maximum, running);
    }
    expect(maximum).toBeLessThanOrEqual(2);
    expect(await fs.readdir(path.join(root, 'test-runs')).catch(() => [])).toEqual([]);
  });
});

describe('manual Skill tests', () => {
  it('shares the config render between preview and the real model request', async () => {
    const { fake, base, headers } = await setup({
      fake: { toolCall: { name: MODEL_TOOL, arguments: { city: '杭州' } }, chatText: 'TRIP_OK' }
    });
    await saveSkillConfig(base, headers, '10001', { city: '杭州', language: '中文' });

    const preview = await request(base, headers, '/accounts/10001/extensions/tests/skill-preview', {
      method: 'POST',
      body: JSON.stringify({ skillId: TRAVEL_SKILL, input: '帮我安排明天的杭州一日游' })
    });
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toMatchObject({
      input: '帮我安排明天的杭州一日游',
      skill: {
        id: TRAVEL_SKILL,
        enabled: true,
        config: { city: '杭州', language: '中文' }
      }
    });
    expect(preview.body.preview.skill.renderedInstructions).toContain('用户配置（JSON）：');
    expect(preview.body.preview.skill.renderedInstructions).toContain('"city":"杭州"');
    expect(preview.body.preview.tools.find((tool: { id: string }) => tool.id === WEATHER_TOOL)).toMatchObject({
      available: true,
      handlerStatus: 'unverified'
    });

    const tested = await testSkill(base, headers, '10001', '帮我安排明天的杭州一日游');
    expect(tested.status).toBe(200);
    expect(tested.body.test).toMatchObject({
      status: 'ok',
      reply: 'TRIP_OK',
      delivery: 'skipped',
      tools: expect.arrayContaining([WEATHER_TOOL]),
      calls: [expect.objectContaining({
        toolId: WEATHER_TOOL,
        arguments: { city: '杭州' },
        result: expect.objectContaining({ status: 'ok' })
      })]
    });
    expect(tested.body.test.calls[0].result.text).toContain('杭州');
    const requestText = fake.calls[0]!.requestText ?? '';
    expect(requestText).toContain('用户配置（JSON）：');
    expect(requestText).toContain('"city":"杭州"');
    expect(requestText).toContain('旅行规划');
    expect(requestText).not.toContain('EXTENSION_TEST_UNKNOWN_SKILL');

    await saveSkillConfig(base, headers, '10001', { city: '苏州', language: '中文' });
    const changed = await testSkill(base, headers, '10001', '再安排一次');
    expect(changed.body.test.status).toBe('ok');
    expect(fake.calls[2]!.requestText ?? '').toContain('"city":"苏州"');
  });

  it('reads a plugin Skill config by its namespaced id without starting extras for preview', async () => {
    const { core, fake, base, headers, root } = await setup({
      fake: { toolCall: { name: MODEL_TOOL, arguments: { city: '杭州' } }, chatText: 'FORECAST_OK' }
    });
    await grant(core, '10001', [WEATHER_TOOL, 'builtin.image.generate'], [TRAVEL_SKILL, PLUGIN_SKILL]);
    await saveSkillConfig(base, headers, '10001', { tone: '简短' }, PLUGIN_SKILL);

    const preview = await request(base, headers, '/accounts/10001/extensions/tests/skill-preview', {
      method: 'POST',
      body: JSON.stringify({ skillId: PLUGIN_SKILL, input: '杭州明天天气如何' })
    });
    expect(preview.status).toBe(200);
    expect(preview.body.preview.skill).toMatchObject({
      id: PLUGIN_SKILL,
      enabled: true,
      config: { tone: '简短' }
    });
    expect(preview.body.preview.skill.renderedInstructions).toContain('先调用 query');
    expect(preview.body.preview.skill.renderedInstructions).toContain('"tone":"简短"');
    expect(preview.body.preview.tools.find((tool: { id: string }) => tool.id === WEATHER_TOOL)).toMatchObject({
      available: true,
      handlerStatus: 'unverified'
    });
    expect(fake.calls).toHaveLength(0);
    expect(await fs.readdir(path.join(root, 'test-runs')).catch(() => [])).toEqual([]);

    const tested = await testSkill(base, headers, '10001', '杭州明天天气如何', PLUGIN_SKILL);
    expect(tested.body.test).toMatchObject({
      status: 'ok',
      reply: 'FORECAST_OK',
      calls: [expect.objectContaining({ toolId: WEATHER_TOOL })]
    });
    const requestText = fake.calls[0]!.requestText ?? '';
    expect(requestText).toContain('天气速报');
    expect(requestText).toContain('"tone":"简短"');
    expect(requestText).not.toContain('旅行规划');
  });

  it('reports a failed tool call and still returns the final reply', async () => {
    const { core, fake, base, headers, root } = await setup({
      fake: { toolCall: { name: 'p_public_failing_run', arguments: {} }, chatText: 'PARTIAL_OK' }
    });
    const dir = await writeLocalPlugin(root, 'failing', {
      'manifest.json': pluginManifest('failing'),
      'index.mjs': 'export const tools = { run: async () => { throw new Error("fixture tool failure"); } };\n'
    });
    const imported = await request(base, headers, '/extensions/imports', {
      method: 'POST',
      body: JSON.stringify({ kind: 'plugin', sourceDirectory: dir, target: { source: 'public' } })
    });
    expect(imported.status).toBe(200);
    await core.saveAccountProfile('10001', {
      version: 1,
      roleCard: { source: 'public', id: 'default', revision: 'r1' },
      plugins: [
        { source: 'public', id: 'weather', revision: 'r1', enabled: true },
        { source: 'public', id: 'failing', revision: 'r1', enabled: true }
      ]
    });
    await grant(core, '10001', [WEATHER_TOOL, 'public/plugin/failing/run', 'builtin.image.generate'], [TRAVEL_SKILL]);
    await saveSkillConfig(base, headers, '10001', { city: '杭州' });

    const tested = await testSkill(base, headers, '10001', '帮我安排行程');
    expect(tested.status).toBe(200);
    expect(tested.body.test).toMatchObject({
      status: 'error',
      stage: 'invoke',
      reply: 'PARTIAL_OK',
      calls: [expect.objectContaining({
        toolId: 'public/plugin/failing/run',
        result: expect.objectContaining({ status: 'error' })
      })],
      delivery: 'skipped'
    });
    expect(fake.calls.length).toBeGreaterThan(1);
  });

  it('returns a model-stage error when the provider fails and does not require QQ to be online', async () => {
    const { base, headers } = await setup({ fake: { failCapability: 'chat', failCode: 'fake_failure' } });
    await saveSkillConfig(base, headers, '10001', { city: '杭州' });
    const tested = await testSkill(base, headers, '10001', '安排一日游');
    expect(tested.status).toBe(200);
    expect(tested.body.test).toMatchObject({
      status: 'error',
      stage: 'model',
      code: 'fake_failure',
      delivery: 'skipped'
    });
    expect(tested.body.test.calls).toEqual([]);
  });

  it('returns an empty call list when the model chooses no tool', async () => {
    const { base, headers } = await setup({ fake: { chatText: 'JUST_TEXT' } });
    await saveSkillConfig(base, headers, '10001', { city: '杭州' });
    const tested = await testSkill(base, headers, '10001', '只聊天');
    expect(tested.body.test).toMatchObject({
      status: 'ok',
      reply: 'JUST_TEXT',
      calls: [],
      delivery: 'skipped'
    });
    expect(tested.body.test.tools).toContain(WEATHER_TOOL);
  });

  it('leaves submitted built-in media jobs queryable and marks delivery skipped', async () => {
    const { base, headers } = await setup({
      fake: { toolCall: { name: 'generate_image', arguments: { prompt: '一张测试图片' } }, chatText: 'IMAGE_DONE' }
    });
    await saveSkillConfig(base, headers, '10001', { city: '杭州' });
    const tested = await testSkill(base, headers, '10001', '生成一张图片');
    expect(tested.status).toBe(200);
    expect(tested.body.test.status).toBe('submitted');
    expect(tested.body.test.jobIds).toHaveLength(1);
    const jobId = tested.body.test.jobIds[0] as string;
    expect(tested.body.test.delivery).toBe('skipped');

    let job: any;
    await waitFor(async () => {
      const response = await request(base, headers, `/jobs/${jobId}?accountId=10001`);
      job = response.body.job;
      return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.state) && job.delivery !== 'pending';
    }, 8_000);
    expect(job).toMatchObject({ id: jobId, accountId: '10001', state: 'succeeded', delivery: 'skipped' });
    expect(job.result.media.length).toBeGreaterThan(0);
  });

  it('reports the target Skill as not injected when the final request excludes it', async () => {
    const { fake, base, headers } = await setup({ fake: { chatText: 'WITHOUT_TARGET_SKILL' } });
    await saveSkillConfig(base, headers, '10001', { city: '杭州' });
    const callsBefore = fake.calls.length;
    const tested = await request(base, headers, '/accounts/10001/extensions/tests/skill', {
      method: 'POST',
      body: JSON.stringify({
        skillId: TRAVEL_SKILL,
        input: '只测试上下文预算',
        roleText: 'R'.repeat(11_000)
      })
    });
    expect(tested.status).toBe(200);
    expect(tested.body.test).toMatchObject({
      status: 'error',
      stage: 'load',
      code: 'skill_not_injected',
      calls: [],
      delivery: 'skipped'
    });
    const chatCalls = fake.calls.slice(callsBefore).filter((call) => call.capability === 'chat');
    expect(chatCalls.length).toBeGreaterThan(0);
    expect(chatCalls[0]!.requestText ?? '').not.toContain('旅行规划');
  });

  it('reports the actual tool list as empty when the model does not support tools', async () => {
    const { fake, base, headers } = await setup({
      fake: { chatText: 'TEXT_ONLY_MODEL' },
      supportsTools: false
    });
    await saveSkillConfig(base, headers, '10001', { city: '杭州' });
    const tested = await testSkill(base, headers, '10001', '只使用正文');
    expect(tested.body.test).toMatchObject({
      status: 'ok',
      reply: 'TEXT_ONLY_MODEL',
      calls: [],
      tools: [],
      delivery: 'skipped'
    });
    const chatCalls = fake.calls.filter((call) => call.capability === 'chat');
    expect(chatCalls.length).toBeGreaterThan(0);
    expect(chatCalls[chatCalls.length - 1]?.toolNames ?? []).toEqual([]);
    expect(chatCalls[0]!.requestText ?? '').toContain('旅行规划');
  });
});

describe('plugin failure stages', () => {
  it('distinguishes load/init/invoke failures and executes top-level code only on an explicit test', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-extension-failure-'));
    roots.push(root);
    const marker = path.join(root, 'side-effect-executed');
    savedMarker = process.env[markerEnvKey];
    process.env[markerEnvKey] = marker;
    const core = await createTestCore({
      dataRoot: root,
      instances: [],
      api: { enabled: true, port: 0, token: 'extension-failure-fixture' },
      logger: silentLogger()
    }, ['10001', '10002']);
    cores.push(core);
    await core.start();
    const base = core.status().apiUrl!;
    const headers = { authorization: 'Bearer extension-failure-fixture', 'content-type': 'application/json' };

    const packages: Array<{ name: string; manifestId: string; files: Record<string, string> }> = [
      {
        name: 'init-fail',
        manifestId: 'init-fail',
        files: {
          'index.mjs': [
            'export async function init() { throw new Error("fixture init failure"); }',
            'export const tools = { run: async () => ({ status: "ok", text: "never" }) };'
          ].join('\n')
        }
      },
      {
        name: 'handler-missing',
        manifestId: 'handler-missing',
        files: { 'index.mjs': 'export const tools = {};\n' }
      },
      {
        name: 'invoke-fail',
        manifestId: 'invoke-fail',
        files: {
          'index.mjs': 'export const tools = { run: async () => { throw new Error("fixture invoke failure"); } };\n'
        }
      },
      {
        name: 'broken-js',
        manifestId: 'broken-js',
        files: { 'index.mjs': 'export const tools = {\n' }
      },
      {
        name: 'missing-dependency',
        manifestId: 'missing-dependency',
        files: {
          'index.mjs': "import absent from 'fixture-package-that-does-not-exist';\nexport const tools = { run: async () => ({ status: 'ok' }) };\n"
        }
      },
      {
        name: 'side-effect',
        manifestId: 'side-effect',
        files: {
          'index.mjs': [
            "import fs from 'node:fs';",
            `if (process.env.${markerEnvKey}) fs.writeFileSync(process.env.${markerEnvKey}, "loaded");`,
            'export const tools = { run: async () => ({ status: "ok", text: "ran" }) };'
          ].join('\n')
        }
      }
    ];
    const refs: Array<{ source: 'public'; id: string; revision: string; enabled: true }> = [];
    for (const entry of packages) {
      const dir = path.join(root, 'imports', 'plugins', entry.name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify({
        id: entry.manifestId,
        kind: 'plugin',
        revision: 'r1',
        entry: 'index.mjs',
        apiVersion: 1,
        tools: [{
          id: 'run',
          description: 'Offline failure fixture.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          effect: 'read'
        }]
      }, null, 2)}\n`, 'utf8');
      for (const [file, content] of Object.entries(entry.files)) await fs.writeFile(path.join(dir, file), content, 'utf8');
      const imported = await request(base, headers, '/extensions/imports', {
        method: 'POST',
        body: JSON.stringify({ kind: 'plugin', sourceDirectory: dir, target: { source: 'public' } })
      });
      expect(imported.status).toBe(200);
      refs.push({ source: 'public', id: entry.manifestId, revision: 'r1', enabled: true });
    }
    await expect(fs.access(marker)).rejects.toThrow();

    await core.saveAccountProfile('10002', {
      version: 1,
      plugins: refs
    });
    await grant(core, '10002', refs.map((ref) => `public/plugin/${ref.id}/run`), []);

    const init = await testTool(base, headers, '10002', 'public/plugin/init-fail/run');
    expect(init.body.test).toMatchObject({ status: 'error', stage: 'init' });

    const broken = await testTool(base, headers, '10002', 'public/plugin/broken-js/run');
    expect(broken.body.test.status).toBe('error');
    expect(['load', 'init']).toContain(broken.body.test.stage);

    const dependency = await testTool(base, headers, '10002', 'public/plugin/missing-dependency/run');
    expect(dependency.body.test.status).toBe('error');
    expect(['load', 'init']).toContain(dependency.body.test.stage);

    const missing = await testTool(base, headers, '10002', 'public/plugin/handler-missing/run');
    expect(missing.body.test).toMatchObject({ status: 'error', stage: 'load', code: 'handler_not_ready' });

    const invoke = await testTool(base, headers, '10002', 'public/plugin/invoke-fail/run');
    expect(invoke.body.test).toMatchObject({ status: 'error', stage: 'invoke' });
    expect(invoke.body.test.calls[0].result.status).toBe('error');

    const sideEffect = await testTool(base, headers, '10002', 'public/plugin/side-effect/run');
    expect(sideEffect.body.test).toMatchObject({ status: 'ok' });
    expect(await fs.readFile(marker, 'utf8')).toBe('loaded');
  });
});
