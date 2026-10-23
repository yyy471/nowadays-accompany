import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/core/logger.js';
import { OpenAiCompatibleAdapter } from '../src/providers/adapters/openai.js';
import type { ProviderCallContext } from '../src/providers/contract.js';
import { parseProvider, type ProviderConfig, type ProviderModelConfig } from '../src/providers/types.js';

const logger = silentLogger('http-body-test');
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function startServer(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<string> {
  const server = http.createServer((request, response) => {
    request.resume();
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function providerFor(baseUrl: string): ProviderConfig {
  return parseProvider({
    id: 'bounded-remote',
    adapterId: 'openai-compatible-v1',
    baseUrl,
    location: 'local',
    models: [
      { id: 'chat', capabilities: ['chat'], input: ['text'] },
      { id: 'image', capabilities: ['image.generate'], input: ['text'] },
      { id: 'audio', capabilities: ['audio.generate'], input: ['text'], parameters: { voice: 'alloy' } }
    ]
  });
}

function contextFor(provider: ProviderConfig, model: ProviderModelConfig, signal: AbortSignal): ProviderCallContext {
  return { provider, model, signal, logger, requestTimeoutMs: 5_000 };
}

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('condition not met'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('provider response body bounds', () => {
  it('ends a stalled chat body when the caller aborts and reports a timeout', async () => {
    let closed = false;
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"choices":');
      response.on('close', () => { closed = true; });
    });
    const provider = providerFor(baseUrl);
    const adapter = new OpenAiCompatibleAdapter();
    await expect(adapter.chat(
      contextFor(provider, provider.models[0]!, AbortSignal.timeout(80)),
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }
    )).rejects.toMatchObject({ code: 'provider_timeout', retryable: true });
    await waitFor(() => closed);
  });

  it('reports an unknown generation result when the image body is cut off', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"data":[{"b64_json":"partial');
      setTimeout(() => response.destroy(), 5);
    });
    const provider = providerFor(baseUrl);
    const adapter = new OpenAiCompatibleAdapter();
    await expect(adapter.imageGenerate(
      contextFor(provider, provider.models[1]!, new AbortController().signal),
      { prompt: 'image' }
    )).rejects.toMatchObject({ code: 'provider_generate_unknown', retryable: false });
  });

  it('reports an unknown generation result when the audio body is cut off', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'audio/mpeg' });
      response.write(Buffer.from('partial-audio'));
      setTimeout(() => response.destroy(), 5);
    });
    const provider = providerFor(baseUrl);
    const adapter = new OpenAiCompatibleAdapter();
    await expect(adapter.audioGenerate(
      contextFor(provider, provider.models[2]!, new AbortController().signal),
      { text: 'hello' }
    )).rejects.toMatchObject({ code: 'provider_generate_unknown', retryable: false });
  });

  it('keeps HTTP status classification when an error body cannot complete', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.write('{"error":');
      setTimeout(() => response.destroy(), 5);
    });
    const provider = providerFor(baseUrl);
    const adapter = new OpenAiCompatibleAdapter();
    await expect(adapter.chat(
      contextFor(provider, provider.models[0]!, new AbortController().signal),
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }
    )).rejects.toMatchObject({ code: 'provider_rate_limit', httpStatus: 429 });
  });
});
