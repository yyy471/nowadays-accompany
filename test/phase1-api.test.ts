import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core.js';
import { FakeChannel } from '../src/channels/fake.js';
import { silentLogger } from '../src/core/logger.js';
import { MemoryCredentialVault } from '../src/secrets/vault.js';
import { bindTestConversation, createTestCore } from './helpers.js';
import {
  fakeMediaProvider,
  fakeProvider,
  textInbound,
  waitFor
} from './phase1-helpers.js';

const roots: string[] = [];
const cores: Core[] = [];

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const TOKEN = 'phase1-token';

interface Setup {
  core: Core;
  url: string;
  channels: Map<string, FakeChannel>;
  root: string;
}

async function setup(options: { vault?: MemoryCredentialVault } = {}): Promise<Setup> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-p1-api-'));
  roots.push(root);
  const channels = new Map<string, FakeChannel>();
  const core = await createTestCore(
    {
      dataRoot: root,
      instances: [
        { id: 'a', backend: 'fake', accountId: '10001' },
        { id: 'b', backend: 'fake', accountId: '10002' }
      ],
      channelFactory: (context) => {
        const channel = new FakeChannel(context, { selfId: context.spec.accountId });
        channels.set(context.instanceId, channel);
        return channel;
      },
      ...(options.vault ? { credentialVault: options.vault } : {}),
      api: { enabled: true, port: 0, token: TOKEN },
      limits: { hostTimeoutMs: 5_000 },
      logger: silentLogger('p1-api')
    },
    ['10001', '10002']
  );
  cores.push(core);
  for (const accountId of ['10001', '10002']) await bindTestConversation(core, accountId, 'private', '555');
  await core.start();
  await waitFor(() => core.status().instances.every((instance) => instance.state === 'online'));
  const url = core.status().apiUrl;
  if (!url) throw new Error('api url missing');
  return { core, url, channels, root };
}

function auth(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const cloudProvider = {
  ...fakeProvider('cloud-chat', { chatText: 'cloud reply' }, {
    location: 'cloud',
    baseUrl: 'https://example.invalid/v1'
  })
};

const mediaProvider = fakeMediaProvider('media');

describe('phase 1 control API', () => {
  it('stores provider credentials write-only and never returns them from any control surface', async () => {
    const vault = new MemoryCredentialVault();
    const { core, url, root } = await setup({ vault });
    const created = await fetch(`${url}/providers`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ provider: cloudProvider, credential: 'sk-live-super-secret-1234' })
    });
    expect(created.status).toBe(201);
    const createdBody = await json<{ provider: { credential: { ref: string; configured: boolean } } }>(created);
    expect(createdBody.provider.credential).toEqual({
      ref: 'provider/cloud-chat',
      configured: true
    });
    const nestedSecret = await fetch(`${url}/providers`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        provider: { ...cloudProvider, id: 'nested-secret-chat' },
        secret: 'sk-nested-secret-9999'
      })
    });
    expect(nestedSecret.status).toBe(201);
    expect(await vault.get('provider/nested-secret-chat')).toBe('sk-nested-secret-9999');

    const listed = await fetch(`${url}/providers`, { headers: auth() });
    const listText = await listed.text();
    expect(listText).not.toContain('sk-live-super-secret');
    expect(listText).toContain('"configured":true');

    const file = await fs.readFile(path.join(root, 'config.v2.json'), 'utf8');
    expect(file).toContain('provider/cloud-chat');
    expect(file).not.toContain('sk-live-super-secret');

    const diagnostics = await fetch(`${url}/diagnostics`, { headers: auth() });
    const diagnosticsText = await diagnostics.text();
    expect(diagnosticsText).not.toContain('sk-live-super-secret');

    const replaced = await fetch(`${url}/providers/cloud-chat/credential`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ secret: 'sk-second-secret-5678' })
    });
    expect(replaced.status).toBe(200);
    expect(await replaced.text()).not.toContain('sk-second-secret');
    expect(await vault.get('provider/cloud-chat')).toBe('sk-second-secret-5678');

    const removed = await fetch(`${url}/providers/cloud-chat/credential`, {
      method: 'DELETE',
      headers: auth()
    });
    const removedBody = await json<{ provider: { credential: { configured: boolean } } }>(removed);
    expect(removedBody.provider.credential.configured).toBe(false);
    expect(await vault.has('provider/cloud-chat')).toBe(false);
    expect(core.credentialStore()).toEqual({ kind: 'memory', available: true });
  });

  it('refuses to save a key when system credential protection is unavailable', async () => {
    const { url, root } = await setup();
    const response = await fetch(`${url}/providers`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ provider: cloudProvider, credential: 'sk-plaintext-should-fail' })
    });
    expect(response.status).toBe(409);
    const body = await json<{ code: string }>(response);
    expect(body.code).toBe('credential_store_unavailable');
    await expect(fs.readFile(path.join(root, 'config.v2.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('saves account policy, exposes effective reasons and pauses the agent without going offline', async () => {
    const { core, url } = await setup({ vault: new MemoryCredentialVault() });
    await fetch(`${url}/providers`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ provider: cloudProvider })
    });

    const policy = {
      allowedProviders: ['cloud-chat'],
      bindings: { chat: { providerId: 'cloud-chat', modelId: 'text-model' } },
      media: { allowCloudUpload: false },
      byKind: { group: { capabilities: { 'image.generate': false } } }
    };
    const saved = await fetch(`${url}/accounts/10001/policy`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ policy })
    });
    expect(saved.status).toBe(200);
    await waitFor(() => core.status().instances.find((instance) => instance.id === 'a')?.agent?.configured === true);

    const effective = await fetch(`${url}/accounts/10001/effective?kind=group&peerId=777`, { headers: auth() });
    const effectiveBody = await json<{
      effective: {
        agentEnabled: boolean;
        capabilities: Array<{ capability: string; enabled: boolean; reason?: string }>;
      };
    }>(effective);
    expect(effectiveBody.effective.agentEnabled).toBe(true);
    expect(effectiveBody.effective.capabilities.find((entry) => entry.capability === 'chat')?.enabled).toBe(true);
    expect(effectiveBody.effective.capabilities.find((entry) => entry.capability === 'image.generate')).toMatchObject({
      enabled: false,
      reason: 'not_configured'
    });

    const paused = await fetch(`${url}/accounts/10001/agent`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ enabled: false })
    });
    expect(paused.status).toBe(200);
    await waitFor(
      () => core.status().instances.find((instance) => instance.id === 'a')?.agent !== undefined
    );
    expect(core.status().instances.find((instance) => instance.id === 'a')?.state).toBe('online');
    const after = await fetch(`${url}/accounts/10001/effective`, { headers: auth() });
    const afterBody = await json<{ effective: { agentEnabled: boolean } }>(after);
    expect(afterBody.effective.agentEnabled).toBe(false);
  });

  it('scopes jobs and media by account and serves media bytes only to the owning account', async () => {
    const { core, url, channels } = await setup({ vault: new MemoryCredentialVault() });
    for (const provider of [cloudProvider, mediaProvider]) {
      await fetch(`${url}/providers`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ provider })
      });
    }
    for (const accountId of ['10001', '10002']) {
      await fetch(`${url}/accounts/${accountId}/policy`, {
        method: 'PUT',
        headers: auth(),
        body: JSON.stringify({
          policy: {
            allowedProviders: ['cloud-chat', 'media'],
            enabledTools: ['builtin.image.generate'],
            bindings: {
              chat: { providerId: 'cloud-chat', modelId: 'text-model' },
              'image.generate': { providerId: 'media', modelId: 'image-model' }
            }
          }
        })
      });
    }
    await waitFor(() => core.status().instances.every((instance) => instance.agent?.configured === true));

    channels.get('b')?.emitInbound(textInbound('b', '10002', '555', 'draw-b', '/draw a cat'));
    await waitFor(async () => (await core.listJobs('10002')).length === 1, 6_000);
    await waitFor(async () => (await core.listJobs('10002'))[0]?.state === 'succeeded', 6_000);
    await waitFor(async () => (await core.listMedia('10002')).length === 1, 6_000);
    const job = (await core.listJobs('10002'))[0]!;
    const media = (await core.listMedia('10002'))[0]!;

    const crossJob = await fetch(`${url}/jobs/${job.id}?accountId=10001`, { headers: auth() });
    expect(crossJob.status).toBe(404);
    const crossCancel = await fetch(`${url}/jobs/${job.id}/cancel`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ accountId: '10001' })
    });
    expect(crossCancel.status).toBe(404);

    const ownJob = await fetch(`${url}/jobs/${job.id}?accountId=10002`, { headers: auth() });
    expect(ownJob.status).toBe(200);

    const crossMedia = await fetch(`${url}/accounts/10001/media/${media.mediaId}`, { headers: auth() });
    expect(crossMedia.status).toBe(404);
    const ownMedia = await fetch(`${url}/accounts/10002/media/${media.mediaId}`, { headers: auth() });
    expect(ownMedia.status).toBe(200);
    expect(ownMedia.headers.get('content-type')).toBe('image/png');
    expect((await ownMedia.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const list = await fetch(`${url}/accounts/10002/media`, { headers: auth() });
    const listBody = await json<{ media: Array<{ mediaId: string }> }>(list);
    expect(listBody.media[0]?.mediaId).toBe(media.mediaId);
  });

  it('requires explicit confirmation for cost-incurring image generation probes', async () => {
    const { url } = await setup({ vault: new MemoryCredentialVault() });
    await fetch(`${url}/providers`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ provider: mediaProvider })
    });
    const without = await fetch(`${url}/providers/media/test`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ capability: 'image.generate', modelId: 'image-model' })
    });
    expect(without.status).toBe(400);
    const withoutBody = await json<{ code: string }>(without);
    expect(withoutBody.code).toBe('cost_confirmation_required');

    const withConfirm = await fetch(`${url}/providers/media/test`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ capability: 'image.generate', modelId: 'image-model', confirmCost: true })
    });
    expect(withConfirm.status).toBe(200);
    const withBody = await json<{ result: { ok: boolean } }>(withConfirm);
    expect(withBody.result.ok).toBe(true);
  });

  it('tests the saved account capability without sending a QQ message and confirms cloud cost', async () => {
    const { url, channels } = await setup({ vault: new MemoryCredentialVault() });
    await fetch(`${url}/providers`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ provider: cloudProvider })
    });
    await fetch(`${url}/accounts/10001/policy`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({
        policy: {
          allowedProviders: ['cloud-chat'],
          bindings: { chat: { providerId: 'cloud-chat', modelId: 'text-model' } }
        }
      })
    });
    const withoutConfirm = await fetch(`${url}/accounts/10001/capabilities/test`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ capability: 'chat' })
    });
    expect(withoutConfirm.status).toBe(400);
    expect(await json<{ code: string }>(withoutConfirm)).toMatchObject({ code: 'cost_confirmation_required' });

    const confirmed = await fetch(`${url}/accounts/10001/capabilities/test`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ capability: 'chat', confirmCost: true })
    });
    expect(confirmed.status).toBe(200);
    const confirmedBody = await json<{ result: { ok: boolean; providerId: string; modelId: string; capability: string; detail?: string } }>(confirmed);
    expect(confirmedBody).toMatchObject({
      result: { ok: true, providerId: 'cloud-chat', modelId: 'text-model', capability: 'chat', detail: '回复：cloud reply' }
    });
    expect(channels.get('a')?.sent).toHaveLength(0);
  });

  it('returns bounded media previews and short real results for capability tests without persisting or sending them', async () => {
    const { core, url, channels } = await setup({ vault: new MemoryCredentialVault() });
    const provider = fakeMediaProvider('media-test', {
      observation: 'A small test image containing a red dot.',
      videoSummary: 'A one-second black test clip.'
    });
    await fetch(`${url}/providers`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ provider })
    });
    await fetch(`${url}/accounts/10001/policy`, {
      method: 'PUT', headers: auth(), body: JSON.stringify({
        policy: {
          allowedProviders: ['media-test'],
          bindings: {
            'image.understand': { providerId: 'media-test', modelId: 'vision-model' },
            'video.understand': { providerId: 'media-test', modelId: 'video-model' },
            'image.generate': { providerId: 'media-test', modelId: 'image-model' },
            'audio.generate': { providerId: 'media-test', modelId: 'audio-model' }
          }
        }
      })
    });

    const test = async (capability: string, confirmCost = false): Promise<{ result: { ok: boolean; detail?: string; sample?: { kind: string; mimeType: string; base64: string } } }> => {
      const response = await fetch(`${url}/accounts/10001/capabilities/test`, {
        method: 'POST', headers: auth(), body: JSON.stringify({ capability, ...(confirmCost ? { confirmCost: true } : {}) })
      });
      expect(response.status).toBe(200);
      return json(response);
    };

    expect((await test('image.understand')).result.detail).toContain('A small test image');
    expect((await test('video.understand')).result.detail).toContain('one-second black test clip');
    const image = (await test('image.generate', true)).result;
    expect(image).toMatchObject({ ok: true, sample: { kind: 'image', mimeType: 'image/png' } });
    expect(Buffer.from(image.sample!.base64, 'base64').length).toBeLessThanOrEqual(1_048_576);
    const audio = (await test('audio.generate', true)).result;
    expect(audio).toMatchObject({ ok: true, sample: { kind: 'audio', mimeType: 'audio/wav' } });
    expect(Buffer.from(audio.sample!.base64, 'base64').length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(await core.listMedia('10001')).toHaveLength(0);
    expect(channels.get('a')?.sent).toHaveLength(0);
  });

  it('does not accept inline secrets through provider upsert', async () => {
    const { url } = await setup({ vault: new MemoryCredentialVault() });
    const inline = {
      ...cloudProvider,
      options: { apiKey: 'sk-inline-should-be-rejected' }
    };
    const response = await fetch(`${url}/providers`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ provider: inline })
    });
    expect(response.status).toBe(400);
    const body = await json<{ code: string }>(response);
    expect(body.code).toBe('invalid_config');
  });
});
