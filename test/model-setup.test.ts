import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/core/core.js';
import { silentLogger } from '../src/core/logger.js';
import { MemoryCredentialVault } from '../src/secrets/vault.js';
import { inferProviderLocation } from '../src/providers/setup.js';

const roots: string[] = [];
const cores: Core[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.join(os.tmpdir(), 'accompany-model-setup-'))) throw new Error('unexpected test cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function upstream() {
  const calls: Array<{ url?: string; auth?: string; body?: any }> = [];
  let modelStatus = 200;
  let chatStatus = 200;
  const server = http.createServer((request, response) => {
    const send = (status: number, data: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
    const call: (typeof calls)[number] = { url: request.url, auth: request.headers.authorization };
    calls.push(call);
    if (request.url === '/v1/models') return send(modelStatus, modelStatus === 200 ? { data: [{ id: 'vendor/model:latest' }, { id: 'plain-model' }, { id: 'plain-model' }] } : {});
    let text = '';
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', () => {
      call.body = JSON.parse(text || '{}');
      if (request.url === '/v1/chat/completions') return send(chatStatus, chatStatus === 200 ? { choices: [{ message: { content: 'pong' } }] } : { error: { message: `rejected ${request.headers.authorization?.slice(7)}` } });
      send(404, {});
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, calls,
    modelStatus: (status: number) => { modelStatus = status; }, chatStatus: (status: number) => { chatStatus = status; } };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-model-setup-'));
  roots.push(root);
  const vault = new MemoryCredentialVault();
  const core = await createCore({ dataRoot: root, instances: [], credentialVault: vault, logger: silentLogger('model-setup'), api: { enabled: true, host: '127.0.0.1', port: 0, token: 'setup-only' } });
  cores.push(core); await core.start();
  const request = async (route: string, body: unknown) => fetch(`${core.status().apiUrl}${route}`, {
    method: 'POST', headers: { authorization: 'Bearer setup-only', 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { core, root, vault, request, remote: await upstream() };
}

describe('simple model settings', () => {
  it('infers internal metadata without misclassifying public names as private IPv6', () => {
    expect(inferProviderLocation('http://192.168.1.2:8000/v1')).toBe('local');
    expect(inferProviderLocation('http://[fd00::2]:8000/v1')).toBe('local');
    expect(inferProviderLocation('https://fcloud.example/v1')).toBe('cloud');
  });
  it('saves URL/key/model without user-managed location, provider id or credential reference', async () => {
    const h = await fixture();
    const response = await h.request('/providers/simple', { capability: 'chat', baseUrl: h.remote.baseUrl, modelId: 'vendor/model:latest', secret: 'private-test-key' });
    expect(response.status).toBe(200);
    const { provider } = await response.json() as any;
    expect(provider.credential.configured).toBe(true);
    expect(provider.location).toBe('local');
    expect(provider.options.settingsModels.chat).toBe('vendor/model:latest');
    expect(await h.vault.get(provider.credential.ref)).toBe('private-test-key');
    expect(await fs.readFile(path.join(h.root, 'config.v2.json'), 'utf8')).not.toContain('private-test-key');
    expect(h.remote.calls).toHaveLength(0);
  });

  it('fetches selectable model names without saving a provider or secret', async () => {
    const h = await fixture();
    const response = await h.request('/providers/models', { baseUrl: h.remote.baseUrl, secret: 'discovery-key' });
    expect(await response.json()).toMatchObject({ ok: true, models: ['plain-model', 'vendor/model:latest'] });
    expect(h.remote.calls[0]?.auth).toBe('Bearer discovery-key');
    expect(h.core.configV2.snapshot().providers).toHaveLength(0);
  });

  it('validates unsaved text, image and video by real minimal protocol requests', async () => {
    const h = await fixture();
    for (const capability of ['chat', 'image.understand', 'video.understand']) {
      const response = await h.request('/providers/validate', { capability, baseUrl: h.remote.baseUrl, modelId: 'vendor/model:latest', secret: 'validate-key', confirmCost: true });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: { ok: true, capability } });
    }
    expect(h.remote.calls).toHaveLength(3);
    expect(h.remote.calls[1]?.body.messages[0].content[1].type).toBe('image_url');
    expect(h.remote.calls[2]?.body.messages[0].content[1]).toMatchObject({ type: 'video_url', video_url: { url: expect.stringMatching(/^data:video\/mp4;base64,/) } });
    expect(h.core.configV2.snapshot().providers).toHaveLength(0);
    expect(h.core.status().instances).toHaveLength(0);
  });

  it('preserves existing models, advanced options, keys and account bindings', async () => {
    const h = await fixture();
    await h.core.upsertProvider({ id: 'existing', adapterId: 'openai-compatible-v1', location: 'local', baseUrl: h.remote.baseUrl,
      models: [{ id: 'old-model', capabilities: ['chat'], supportsTools: true, parameters: { temperature: 0.7 } }],
      limits: { maxConcurrent: 1, maxQueue: 3 }, options: { custom: 'keep' } }, 'existing-key');
    await h.core.setAccountPolicy('10001', { allowedProviders: ['existing'], bindings: { chat: { providerId: 'existing', modelId: 'old-model' } } });
    const policy = h.core.getAccountPolicy('10001');
    const saved = await h.core.configureSimpleModel({ providerId: 'existing', capability: 'chat', baseUrl: h.remote.baseUrl, modelId: 'new/model:latest' });
    expect(saved.models.map((model) => model.id)).toEqual(['old-model', 'new/model:latest']);
    expect(saved.options.custom).toBe('keep');
    expect(saved.limits).toEqual({ maxConcurrent: 1, maxQueue: 3 });
    expect(saved.credential.configured).toBe(true);
    expect(h.core.getAccountPolicy('10001')).toEqual(policy);
    await h.core.validateSimpleModel({ providerId: 'existing', capability: 'chat', baseUrl: h.remote.baseUrl, modelId: 'new/model:latest' });
    expect(h.remote.calls[0]?.auth).toBe('Bearer existing-key');
  });

  it('moves one fixed selection without removing other capability selections', async () => {
    const h = await fixture();
    const a = await h.core.configureSimpleModel({ capability: 'chat', baseUrl: h.remote.baseUrl, modelId: 'one' });
    await h.core.configureSimpleModel({ providerId: a.id, capability: 'image.understand', baseUrl: h.remote.baseUrl, modelId: 'one' });
    const b = await h.core.configureSimpleModel({ capability: 'chat', baseUrl: h.remote.baseUrl, modelId: 'two' });
    const old = h.core.configV2.provider(a.id)!;
    expect(old.options.settingsModels).toEqual({ 'image.understand': 'one' });
    expect(b.options.settingsModels).toEqual({ chat: 'two' });
  });

  it('serializes concurrent edits to a shared service without losing either model', async () => {
    const h = await fixture();
    const saved = await h.core.configureSimpleModel({ capability: 'chat', baseUrl: h.remote.baseUrl, modelId: 'old' });
    await Promise.all([
      h.core.configureSimpleModel({ providerId: saved.id, capability: 'image.understand', baseUrl: h.remote.baseUrl, modelId: 'vision' }),
      h.core.configureSimpleModel({ providerId: saved.id, capability: 'video.understand', baseUrl: h.remote.baseUrl, modelId: 'video' })
    ]);
    const current = h.core.configV2.provider(saved.id)!;
    expect(current.models.map((model) => model.id).sort()).toEqual(['old', 'video', 'vision']);
    expect(current.options.settingsModels).toEqual({ chat: 'old', 'image.understand': 'vision', 'video.understand': 'video' });
  });

  it('protects other services that used a shared credential reference when one key changes', async () => {
    const h = await fixture();
    for (const id of ['first', 'second']) await h.core.upsertProvider({ id, adapterId: 'openai-compatible-v1', baseUrl: h.remote.baseUrl, location: 'local', credentialRef: 'shared/key', models: [{ id: 'm', capabilities: ['chat'] }] }, 'shared-old-key');
    const changed = await h.core.configureSimpleModel({ providerId: 'first', capability: 'chat', baseUrl: h.remote.baseUrl, modelId: 'm', secret: 'first-new-key' });
    expect(changed.credential.ref).not.toBe('shared/key');
    expect(await h.vault.get('shared/key')).toBe('shared-old-key');
    expect(await h.vault.get(changed.credential.ref!)).toBe('first-new-key');
    expect(h.core.configV2.provider('second')?.credentialRef).toBe('shared/key');
  });

  it('does not forward a saved key to a newly entered origin', async () => {
    const h = await fixture();
    const saved = await h.core.configureSimpleModel({ capability: 'chat', baseUrl: h.remote.baseUrl, modelId: 'm', secret: 'old-private-key' });
    const other = await upstream();
    await h.core.discoverModels({ providerId: saved.id, baseUrl: other.baseUrl });
    expect(other.calls[0]?.auth).toBeUndefined();
    const changed = await h.core.configureSimpleModel({ providerId: saved.id, capability: 'chat', baseUrl: other.baseUrl, modelId: 'm' });
    expect(changed.credential.configured).toBe(false);
  });

  it('reports unsupported listing separately so manual model names can still validate', async () => {
    const h = await fixture(); h.remote.modelStatus(404);
    const listed = await h.request('/providers/models', { baseUrl: h.remote.baseUrl });
    expect(listed.ok).toBe(false);
    expect((await listed.json() as any).error).toContain('手动输入');
    expect(await h.core.validateSimpleModel({ capability: 'chat', baseUrl: h.remote.baseUrl, modelId: 'manual:model' })).toMatchObject({ ok: true });
  });

  it('returns upstream validation failures without echoing the supplied key', async () => {
    const h = await fixture(); h.remote.chatStatus(401);
    const response = await h.request('/providers/validate', { capability: 'chat', baseUrl: h.remote.baseUrl, modelId: 'm', secret: 'arbitrary-sensitive-key' });
    expect(response.ok).toBe(false);
    expect(await response.text()).not.toContain('arbitrary-sensitive-key');
    expect(h.core.configV2.snapshot().providers).toHaveLength(0);
  });

  it('allows clearing an audio voice with an explicit empty value', async () => {
    const h = await fixture();
    const saved = await h.core.configureSimpleModel({ capability: 'audio.generate', baseUrl: h.remote.baseUrl, modelId: 'tts-model', parameters: { voice: 'alloy' } });
    const cleared = await h.core.configureSimpleModel({ providerId: saved.id, capability: 'audio.generate', baseUrl: h.remote.baseUrl, modelId: 'tts-model', parameters: { voice: '' } });
    expect(cleared.models.find((model) => model.id === 'tts-model')?.parameters.voice).toBe('');
  });

  it('rejects an adapter that does not support the selected capability', async () => {
    const h = await fixture();
    const saved = await h.core.configureSimpleModel({ capability: 'chat', baseUrl: h.remote.baseUrl, modelId: 'chat-model' });
    await expect(h.core.configureSimpleModel({
      providerId: saved.id,
      capability: 'chat',
      baseUrl: h.remote.baseUrl,
      modelId: 'chat-model',
      adapterId: 'video-polling-v1'
    })).rejects.toThrow(/does not support chat/);
  });
});
