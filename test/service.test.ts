import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core.js';
import { createTestCore as createCore } from './helpers.js';
import { FakeChannel } from '../src/channels/fake.js';
import { silentLogger } from '../src/core/logger.js';
import { createApiServer } from '../src/service/server.js';
import type { Limits } from '../src/core/limits.js';

const roots: string[] = [];
const cores: Core[] = [];

const TOKEN = 'test-token';

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function setup(options: { limits?: Partial<Limits> } = {}): Promise<{ core: Core; url: string; channels: Map<string, FakeChannel> }> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-api-'));
  roots.push(dataRoot);
  const channels = new Map<string, FakeChannel>();
  const core = await createCore({
    dataRoot,
    instances: [
      { id: 'a', backend: 'fake', accountId: '10001' },
      { id: 'b', backend: 'fake', accountId: '20002' }
    ],
    channelFactory: (context) => {
      const channel = new FakeChannel(context, { selfId: context.spec.accountId });
      channels.set(context.instanceId, channel);
      return channel;
    },
    api: { enabled: true, port: 0, token: TOKEN },
    ...(options.limits ? { limits: options.limits } : {}),
    logger: silentLogger('api-test')
  });
  cores.push(core);
  await core.start();
  const url = core.status().apiUrl;
  if (!url) throw new Error('api url missing');
  return { core, url, channels };
}

function auth(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

describe('local control API', () => {
  it('serves health without a token and protects everything else', async () => {
    const { url } = await setup();
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, instances: 2 });

    const unauthorized = await fetch(`${url}/instances`);
    expect(unauthorized.status).toBe(401);
  });

  it('lists instances and sends through the owning instance', async () => {
    const { url, channels } = await setup();
    const list = await fetch(`${url}/instances`, { headers: auth() });
    const payload = (await list.json()) as { instances: Array<{ id: string; state: string }> };
    expect(payload.instances.map((item) => item.id)).toEqual(['a', 'b']);
    expect(payload.instances.every((item) => item.state === 'online')).toBe(true);

    const response = await fetch(`${url}/instances/a/send`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ kind: 'private', peerId: '555', text: 'hello from api' })
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; messageId: string };
    expect(body.ok).toBe(true);
    expect(body.messageId).toBe('fake-1');
    expect(channels.get('a')?.sent[0]?.conversation).toEqual({
      accountId: '10001',
      kind: 'private',
      peerId: '555'
    });
    expect(channels.get('b')?.sent).toHaveLength(0);
  });

  it('rejects bad input and unknown instances', async () => {
    const { url } = await setup();
    expect((await fetch(`${url}/instances/nope/start`, { method: 'POST', headers: auth() })).status).toBe(404);
    const badKind = await fetch(`${url}/instances/a/send`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ kind: 'guild', peerId: '1', text: 'x' })
    });
    expect(badKind.status).toBe(400);
    const noMessage = await fetch(`${url}/instances/a/send`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ kind: 'private', peerId: '1' })
    });
    expect(noMessage.status).toBe(400);
  });

  it('streams events over SSE', async () => {
    const { url } = await setup();
    const controller = new AbortController();
    const response = await fetch(`${url}/events`, { headers: auth(), signal: controller.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('no stream');
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(': connected');
    controller.abort();
  });

  it('supports idempotent sends', async () => {
    const { url, channels } = await setup();
    const headers = { ...auth(), 'idempotency-key': 'send-once' };
    const body = JSON.stringify({ kind: 'private', peerId: '555', text: 'once' });
    const first = await fetch(`${url}/instances/a/send`, { method: 'POST', headers, body });
    const firstBody = (await first.json()) as { messageId: string; duplicate?: boolean };
    const second = await fetch(`${url}/instances/a/send`, { method: 'POST', headers, body });
    const secondBody = (await second.json()) as { messageId: string; duplicate?: boolean };
    expect(firstBody.messageId).toBe('fake-1');
    expect(secondBody).toMatchObject({ messageId: 'fake-1', duplicate: true });
    expect(channels.get('a')?.sent).toHaveLength(1);
  });

  it('exposes metrics, diagnostics and v1 aliases', async () => {
    const { url } = await setup();
    const metrics = await fetch(`${url}/metrics`, { headers: auth() });
    const metricsBody = (await metrics.json()) as { metrics: Record<string, number> };
    expect(metricsBody.metrics['instances.total']).toBe(2);

    const diagnostics = await fetch(`${url}/diagnostics`, { headers: auth() });
    const diagnosticsBody = (await diagnostics.json()) as { limits: { maxInstances: number }; runtimes: unknown[] };
    expect(diagnosticsBody.limits.maxInstances).toBeGreaterThan(0);
    expect(diagnosticsBody.runtimes.length).toBe(2);

    const v1 = await fetch(`${url}/v1/instances`, { headers: auth() });
    expect(v1.status).toBe(200);

    const conversations = await fetch(`${url}/conversations?accountId=10001`, { headers: auth() });
    expect(conversations.status).toBe(200);
    expect(await conversations.json()).toMatchObject({ ok: true, conversations: [] });

    const ready = await fetch(`${url}/health/ready`);
    expect(ready.status).toBe(200);
    expect((await ready.json()) as { ready: boolean }).toMatchObject({ ready: true });
  });

  it('returns structured error codes and request ids', async () => {
    const { url } = await setup();
    const response = await fetch(`${url}/instances/a/send`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ kind: 'guild', peerId: '1', text: 'x' })
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(await response.json()).toMatchObject({ ok: false, code: 'invalid_spec' });
  });

  it('replays SSE events from Last-Event-ID', async () => {
    const { core, url } = await setup();
    const send = await fetch(`${url}/instances/a/send`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ kind: 'private', peerId: '555', text: 'resume-me' })
    });
    expect(send.status).toBe(200);
    const target = core.eventLog.latestId;
    expect(target).toBeGreaterThan(0);

    const controller = new AbortController();
    const response = await fetch(`${url}/events`, {
      headers: { ...auth(), 'last-event-id': String(target - 1) },
      signal: controller.signal
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('no stream');
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 2_000;
    while (!text.includes('event: channel:outbound') && Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) => {
          const timer = setTimeout(() => resolve({ done: true, value: undefined }), 1_000);
          timer.unref?.();
        })
      ]);
      if (result.done) break;
      text += decoder.decode(result.value);
    }
    expect(text).toContain(`id: ${target}`);
    expect(text).toContain('event: channel:outbound');
    controller.abort();
  });

  it('maps backpressure and size limits to HTTP status codes', async () => {
    const { url, channels } = await setup({ limits: { maxMessageBytes: 32 } });
    const response = await fetch(`${url}/instances/a/send`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ kind: 'private', peerId: '555', text: 'x'.repeat(100) })
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, code: 'message_too_large' });
    expect(channels.get('a')?.sent).toHaveLength(0);
  });

  it('refuses a non-loopback bind without a token', async () => {
    const { core } = await setup();
    await expect(createApiServer({ core, host: '0.0.0.0', port: 0 })).rejects.toThrow(/token/);
  });
});
