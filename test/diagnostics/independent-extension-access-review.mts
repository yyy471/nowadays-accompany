/** 139/140 独立复核探针：仅临时数据、离线 Worker 和 fake-v1，不修改业务代码。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createTestCore } from '../helpers.js';
import { accountPolicy, bind, fakeProvider, writePhase1Config } from '../phase1-helpers.js';
import { silentLogger } from '../../src/core/logger.js';
import { FakeProviderAdapter } from '../../src/providers/adapters/fake.js';
import type { Core } from '../../src/core/core.js';

const tempRoot = await fs.realpath(os.tmpdir());
const root = await fs.mkdtemp(path.join(tempRoot, 'accompany-independent-ext-'));
const output: Record<string, unknown> = {};
let core: Core | undefined;

async function writePlugin(id: string, source: string) {
  const directory = path.join(root, 'public', 'artifacts', 'plugin', id, 'r1');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    id, kind: 'plugin', revision: 'r1', entry: 'index.mjs', apiVersion: 1,
    tools: [{
      id: 'run', description: 'Offline review probe.', effect: 'read',
      inputSchema: {
        type: 'object', properties: { delay: { type: 'integer', minimum: 0, maximum: 2000 } },
        additionalProperties: false
      }
    }]
  }));
  await fs.writeFile(path.join(directory, 'index.mjs'), source);
}

try {
  const fake = new FakeProviderAdapter();
  await writePhase1Config(root, {
    providers: [fakeProvider('fake-chat', { chatText: 'review reply' }, {
      models: [{ id: 'tool-model', capabilities: ['chat'], input: ['text'], supportsTools: true }]
    })],
    accountPolicies: {
      '10001': accountPolicy({ allowedProviders: ['fake-chat'], bindings: { chat: bind('fake-chat', 'tool-model') } })
    }
  });
  core = await createTestCore({
    dataRoot: root, instances: [], logger: silentLogger(), providerAdapters: [fake],
    api: { enabled: true, port: 0, token: 'offline-independent-review' }
  }, ['10001']);
  await core.start();
  const base = core.status().apiUrl!;
  async function request(route: string, body?: unknown) {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer offline-independent-review', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { http: response.status, body: await response.json() as any };
  }

  const goodMarker = path.join(root, 'good-loads.txt');
  const disabledMarker = path.join(root, 'disabled-loads.txt');
  await writePlugin('good', `
    import fs from 'node:fs';
    fs.appendFileSync(${JSON.stringify(goodMarker)}, 'loaded\\n');
    export const tools = { async run(args) {
      const start = Date.now();
      await new Promise(resolve => setTimeout(resolve, args.delay || 0));
      return { status: 'ok', data: { start, end: Date.now() }, text: 'done' };
    } };
  `);
  await writePlugin('disabled', `
    import fs from 'node:fs';
    fs.appendFileSync(${JSON.stringify(disabledMarker)}, 'loaded\\n');
    export const tools = { run() { return { status: 'ok', text: 'disabled fixture' }; } };
  `);
  await core.saveAccountProfile('10001', {
    version: 1,
    plugins: ['good', 'disabled'].map(id => ({ source: 'public', id, revision: 'r1', enabled: true }))
  });

  const denied = await request('/accounts/10001/extensions/tests/tool', {
    toolId: 'public/plugin/good/run', arguments: {}
  });
  output.closedPluginStartup = {
    response: denied,
    targetWasLoaded: await fs.readFile(goodMarker, 'utf8').then(() => true, () => false),
    unrelatedClosedPluginWasLoaded: await fs.readFile(disabledMarker, 'utf8').then(() => true, () => false),
    policy: core.getAccountPolicy('10001').extensions ?? {}
  };

  const policy = await core.getExtensionPolicy('10001');
  await core.updateExtensionPolicy('10001', {
    expectedRevision: policy.revision,
    patch: {
      authorizedTools: ['public/plugin/good/run'],
      defaults: { plugins: { 'public/plugin/good': 'on' }, tools: { 'public/plugin/good/run': 'on' } }
    }
  });
  const concurrent = await Promise.all(Array.from({ length: 5 }, () =>
    request('/accounts/10001/extensions/tests/tool', {
      toolId: 'public/plugin/good/run', arguments: { delay: 1000 }
    })
  ));
  const intervals = concurrent.map(response => {
    assert.equal(response.http, 200);
    assert.equal(response.body.test.status, 'ok');
    return response.body.test.calls[0].result.data as { start: number; end: number };
  });
  let running = 0;
  let maximum = 0;
  for (const event of intervals.flatMap(item => [{ at: item.start, delta: 1 }, { at: item.end, delta: -1 }])
    .sort((left, right) => left.at - right.at || left.delta - right.delta)) {
    running += event.delta;
    maximum = Math.max(maximum, running);
  }
  output.concurrency = { requests: concurrent.length, actualMaximumSameAccount: maximum, expectedPerAccount: 2, intervals };

  const sentinel = 'REVIEW_TARGET_SKILL_SENTINEL';
  await core.savePublicSkill({
    id: 'budget-probe', name: 'Budget probe', instructions: `${sentinel}\n${'S'.repeat(4000)}`,
    tools: [], enabled: true
  }, core.listPublicSkills().revision);
  const from = fake.calls.length;
  const budget = await request('/accounts/10001/extensions/tests/skill', {
    skillId: 'budget-probe', input: 'Hello', roleText: 'R'.repeat(11000)
  });
  const actualCalls = fake.calls.slice(from).filter(call => call.capability === 'chat');
  output.skillBudget = {
    response: budget,
    actualModelCalls: actualCalls.length,
    actualPromptContainsSkill: actualCalls.some(call => call.requestText?.includes(sentinel)),
    actualModelToolNames: actualCalls.map(call => call.toolNames ?? [])
  };

  await core.upsertProvider(fakeProvider('fake-chat', { chatText: 'review reply without tools' }, {
    models: [{ id: 'tool-model', capabilities: ['chat'], input: ['text'], supportsTools: false }]
  }));
  const withoutToolsFrom = fake.calls.length;
  const withoutTools = await request('/accounts/10001/extensions/tests/skill', {
    skillId: 'budget-probe', input: 'Hello'
  });
  output.offeredTools = {
    response: withoutTools,
    actualModelToolNames: fake.calls.slice(withoutToolsFrom).filter(call => call.capability === 'chat')
      .map(call => call.toolNames ?? [])
  };

  await core.savePublicSkill({
    id: 'constructor', name: 'Constructor skill', instructions: 'A valid ordinary Skill id.', tools: [], enabled: true
  }, core.listPublicSkills().revision);
  const constructorConfig = await request('/accounts/10001/extensions/config?kind=skill&id=constructor');
  const normalConfig = await core.getExtensionConfig('10001', 'skill', 'budget-probe');
  await core.saveExtensionConfig('10001', 'skill', 'budget-probe', {
    config: { city: '杭州' }, expectedRevision: normalConfig.revision
  });
  const unrelatedPreview = await request('/accounts/10001/extensions/tests/skill-preview', {
    skillId: 'budget-probe', input: 'Hello'
  });
  output.inheritedConfigKey = {
    validSkillWasSaved: true, configResponse: constructorConfig, unrelatedSkillPreview: unrelatedPreview
  };

  console.log(JSON.stringify(output, null, 2));
  await fs.mkdir(path.join(process.cwd(), 'test-results', 'independent-extension-review'), { recursive: true });
  await fs.writeFile(path.join(process.cwd(), 'test-results', 'independent-extension-review', 'probes.json'), JSON.stringify(output, null, 2));
} finally {
  await core?.stop();
  const resolvedRoot = path.resolve(root);
  assert.ok(resolvedRoot.startsWith(path.join(tempRoot, 'accompany-independent-ext-')));
  await fs.rm(resolvedRoot, { recursive: true, force: true });
}
