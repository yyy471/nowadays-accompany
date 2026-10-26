import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/core/logger.js';
import { JobError } from '../src/providers/errors.js';
import { parseProvider } from '../src/providers/types.js';
import type { ProviderConfig, ProviderModelConfig } from '../src/providers/types.js';
import type {
  AudioGenerationRequest,
  ChatRequest,
  ImageGenerationRequest,
  ProviderCallContext,
  ProviderMedia
} from '../src/providers/contract.js';
import { OpenAiCompatibleAdapter } from '../src/providers/adapters/openai.js';
import { VideoPollingAdapter } from '../src/providers/adapters/video.js';

const logger = silentLogger('adapter-test');

interface CapturedRequest {
  method: string;
  url: string;
  authorization?: string;
  body: string;
}

type Handler = (request: CapturedRequest, response: http.ServerResponse) => void | Promise<void>;

async function withServer(handler: Handler, run: (baseUrl: string, requests: CapturedRequest[]) => Promise<void>): Promise<void> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const captured: CapturedRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        body: Buffer.concat(chunks).toString('utf8')
      };
      requests.push(captured);
      void Promise.resolve(handler(captured, response)).catch(() => {
        response.statusCode = 500;
        response.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(baseUrl, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function parseBody(request: CapturedRequest | undefined): Record<string, any> {
  expect(request).toBeDefined();
  return JSON.parse(request!.body) as Record<string, any>;
}

function contextFor(
  provider: ProviderConfig,
  model: ProviderModelConfig,
  signal: AbortSignal,
  credential?: string
): ProviderCallContext {
  return {
    provider,
    model,
    signal,
    logger,
    requestTimeoutMs: 5_000,
    ...(credential ? { credential } : {})
  };
}

function openAiProvider(baseUrl: string, overrides: Record<string, unknown> = {}): ProviderConfig {
  return parseProvider({
    id: 'local-openai',
    adapterId: 'openai-compatible-v1',
    baseUrl,
    location: 'local',
    credentialRef: 'provider/local-openai',
    models: [
      { id: 'local-chat', capabilities: ['chat'], input: ['text'], supportsTools: true },
      { id: 'local-image', capabilities: ['image.generate'], input: ['text'] }
    ],
    ...overrides
  });
}

function videoProvider(baseUrl: string, overrides: Record<string, unknown> = {}): ProviderConfig {
  return parseProvider({
    id: 'local-video',
    adapterId: 'video-polling-v1',
    baseUrl,
    location: 'local',
    credentialRef: 'provider/local-video',
    models: [{ id: 'local-video-model', capabilities: ['video.understand'], input: ['video'] }],
    timeouts: { pollIntervalMs: 5, pollTimeoutMs: 2_000 },
    ...overrides
  });
}

const chatRequest: ChatRequest = {
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] }
  ],
  tools: [
    {
      name: 'lookup',
      description: 'Look something up',
      parameters: { type: 'object', properties: { q: { type: 'string' } } }
    }
  ]
};

const videoMedia: ProviderMedia = {
  mediaId: 'media-1',
  accountId: '10001',
  mimeType: 'video/mp4',
  bytes: 8,
  kind: 'video',
  data: Buffer.from('fake-mp4')
};

describe('openai-compatible adapter over local HTTP', () => {
  it('sends the configured model, bearer credential and parses text, tools and usage', async () => {
    await withServer(
      (_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'hello back',
                  tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{"q":"cats"}' } }]
                },
                finish_reason: 'stop'
              }
            ],
            usage: { prompt_tokens: 7, completion_tokens: 3 }
          })
        );
      },
      async (baseUrl, requests) => {
        const provider = openAiProvider(baseUrl);
        const result = await new OpenAiCompatibleAdapter().chat(
          contextFor(provider, provider.models[0]!, new AbortController().signal, 'sk-abcdefghijklmnop'),
          chatRequest
        );
        expect(result).toMatchObject({
          text: 'hello back',
          toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { q: 'cats' } }],
          finishReason: 'stop',
          usage: { promptTokens: 7, completionTokens: 3 }
        });
        const request = requests[0]!;
        expect(request.url).toBe('/chat/completions');
        expect(request.authorization).toBe('Bearer sk-abcdefghijklmnop');
        const body = parseBody(request);
        expect(body).toMatchObject({ model: 'local-chat', stream: false });
        expect(body.messages).toEqual([
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hello' }
        ]);
        expect(body.tools[0]).toMatchObject({ type: 'function', function: { name: 'lookup' } });
      }
    );
  });

  it('serializes assistant tool calls and paired tool results for the follow-up request', async () => {
    await withServer(
      (_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: 'final answer' }, finish_reason: 'stop' }] }));
      },
      async (baseUrl, requests) => {
        const provider = openAiProvider(baseUrl);
        const result = await new OpenAiCompatibleAdapter().chat(
          contextFor(provider, provider.models[0]!, new AbortController().signal, 'sk-abcdefghijklmnop'),
          {
            messages: [
              { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
              { role: 'user', content: [{ type: 'text', text: 'lookup cats' }] },
              { role: 'assistant', content: [], toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { q: 'cats' } }] },
              { role: 'tool', content: [{ type: 'text', text: '{"result":"four lives"}' }], name: 'lookup', toolCallId: 'call-1' },
              {
                role: 'assistant',
                content: [{ type: 'text', text: '中间说明' }],
                toolCalls: [{ id: 'call-2', name: 'lookup', arguments: { q: 'dogs' } }]
              },
              { role: 'tool', content: [{ type: 'text', text: '{"result":"ok"}' }], toolCallId: 'call-2' }
            ]
          }
        );
        expect(result.text).toBe('final answer');
        const body = parseBody(requests[0]);
        expect(body.messages[2]).toEqual({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"cats"}' } }]
        });
        expect(body.messages[3]).toEqual({
          role: 'tool',
          content: '{"result":"four lives"}',
          name: 'lookup',
          tool_call_id: 'call-1'
        });
        expect(body.messages[4]).toMatchObject({ role: 'assistant', content: '中间说明' });
        expect(body.messages[5]).toMatchObject({ role: 'tool', content: '{"result":"ok"}', tool_call_id: 'call-2' });
        expect(body.messages[5]).not.toHaveProperty('name');
      }
    );
  });

  it('refuses protocol-invalid tool messages before sending the request', async () => {
    const adapter = new OpenAiCompatibleAdapter();
    const provider = openAiProvider('http://127.0.0.1:9/unused');
    const context = contextFor(provider, provider.models[0]!, new AbortController().signal, 'sk-abcdefghijklmnop');

    await expect(adapter.chat(context, {
      messages: [{ role: 'tool', content: [{ type: 'text', text: 'orphan result' }] }]
    })).rejects.toMatchObject({ code: 'provider_protocol' });

    await expect(adapter.chat(context, {
      messages: [{ role: 'user', content: [], toolCalls: [{ id: 'call-9', name: 'lookup', arguments: {} }] }]
    })).rejects.toMatchObject({ code: 'provider_protocol' });

    await expect(adapter.chat(context, {
      messages: [{ role: 'assistant', content: [], toolCalls: [{ id: '', name: 'lookup', arguments: {} }] }]
    })).rejects.toMatchObject({ code: 'provider_protocol' });
  });

  it('classifies 401 and redacts credentials from the error text', async () => {
    const credential = 'sk-abcdefghijklmnopqrstuvwxyz';
    await withServer(
      (_request, response) => {
        response.statusCode = 401;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: { message: `invalid api key ${credential}` } }));
      },
      async (baseUrl) => {
        const provider = openAiProvider(baseUrl);
        const error = (await new OpenAiCompatibleAdapter()
          .chat(contextFor(provider, provider.models[0]!, new AbortController().signal, credential), chatRequest)
          .catch((caught: unknown) => caught)) as Error & {
          code?: string;
          retryable?: boolean;
          httpStatus?: number;
        };
        expect(error).toMatchObject({ code: 'provider_auth', retryable: false, httpStatus: 401 });
        expect(error.message).not.toContain(credential);
      }
    );
  });

  it('classifies 429 with a bounded retry hint and invalid JSON as protocol errors', async () => {
    await withServer(
      (_request, response) => {
        response.statusCode = 429;
        response.setHeader('retry-after', '2');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: { message: 'slow down' } }));
      },
      async (baseUrl) => {
        const provider = openAiProvider(baseUrl);
        const error = await new OpenAiCompatibleAdapter()
          .chat(contextFor(provider, provider.models[0]!, new AbortController().signal), chatRequest)
          .catch((caught: unknown) => caught as { code?: string; retryable?: boolean; retryAfterMs?: number });
        expect(error).toMatchObject({ code: 'provider_rate_limit', retryable: true, retryAfterMs: 2_000 });
      }
    );

    await withServer(
      (_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end('not-json');
      },
      async (baseUrl) => {
        const provider = openAiProvider(baseUrl);
        const error = await new OpenAiCompatibleAdapter()
          .chat(contextFor(provider, provider.models[0]!, new AbortController().signal), chatRequest)
          .catch((caught: unknown) => caught as { code?: string; retryable?: boolean });
        expect(error).toMatchObject({ code: 'provider_protocol', retryable: false });
      }
    );
  });

  it('classifies an aborted chat request as a retryable timeout', async () => {
    await withServer(
      (_request, response) => {
        setTimeout(() => {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] }));
        }, 300);
      },
      async (baseUrl) => {
        const provider = openAiProvider(baseUrl);
        const signal = AbortSignal.timeout(30);
        const error = await new OpenAiCompatibleAdapter()
          .chat(contextFor(provider, provider.models[0]!, signal), chatRequest)
          .catch((caught: unknown) => caught as { code?: string; retryable?: boolean });
        expect(error).toMatchObject({ code: 'provider_timeout', retryable: true });
      }
    );
  });

  it('marks a 5xx image generation response as unknown and non-retryable', async () => {
    await withServer(
      (_request, response) => {
        response.statusCode = 503;
        response.end('busy');
      },
      async (baseUrl) => {
        const provider = openAiProvider(baseUrl);
        const request: ImageGenerationRequest = { prompt: 'a cat' };
        const error = await new OpenAiCompatibleAdapter()
          .imageGenerate(
            contextFor(provider, provider.models[1]!, new AbortController().signal),
            request
          )
          .catch((caught: unknown) => caught as { code?: string; retryable?: boolean });
        expect(error).toMatchObject({ code: 'provider_generate_unknown', retryable: false });
      }
    );
  });

  it('routes speech generation to /audio/speech and persists the returned audio bytes', async () => {
    const wave = Buffer.from('RIFF-test-audio');
    await withServer(
      (request, response) => {
        expect(request.method).toBe('POST');
        expect(request.url).toBe('/audio/speech');
        response.setHeader('content-type', 'audio/wav');
        response.end(wave);
      },
      async (baseUrl, requests) => {
        const provider = parseProvider({
          id: 'local-speech',
          adapterId: 'openai-compatible-v1',
          baseUrl,
          location: 'local',
          credentialRef: 'provider/local-speech',
          models: [{ id: 'speech-model', capabilities: ['audio.generate'], input: ['text'] }]
        });
        const request: AudioGenerationRequest = { text: 'hello from Accompany', voice: 'alloy', format: 'wav' };
        const result = await new OpenAiCompatibleAdapter().audioGenerate(
          contextFor(provider, provider.models[0]!, new AbortController().signal, 'speech-key'),
          request
        );
        expect(result).toMatchObject({ mimeType: 'audio/wav', data: wave });
        expect(requests[0]?.authorization).toBe('Bearer speech-key');
        expect(parseBody(requests[0])).toMatchObject({
          model: 'speech-model', input: 'hello from Accompany', voice: 'alloy', response_format: 'wav'
        });
      }
    );
  });

  it('uses the model default voice when the audio tool omits voice', async () => {
    const wave = Buffer.from('RIFF-default-voice');
    await withServer(
      (_request, response) => {
        response.setHeader('content-type', 'audio/wav');
        response.end(wave);
      },
      async (baseUrl, requests) => {
        const provider = parseProvider({
          id: 'local-speech-default',
          adapterId: 'openai-compatible-v1',
          baseUrl,
          location: 'local',
          models: [{ id: 'speech-model', capabilities: ['audio.generate'], input: ['text'], parameters: { voice: 'narrator-default' } }]
        });
        const request: AudioGenerationRequest = { text: 'play this aloud', format: 'wav' };
        const result = await new OpenAiCompatibleAdapter().audioGenerate(
          contextFor(provider, provider.models[0]!, new AbortController().signal),
          request
        );
        expect(result.data).toEqual(wave);
        expect(parseBody(requests[0])).toMatchObject({
          model: 'speech-model', input: 'play this aloud', voice: 'narrator-default', response_format: 'wav'
        });
      }
    );
  });

  it('fails with a configuration error before HTTP when no TTS voice is configured', async () => {
    await withServer(
      (_request, response) => { response.end(Buffer.from('should not be called')); },
      async (baseUrl, requests) => {
        const provider = parseProvider({
          id: 'local-speech-missing-voice',
          adapterId: 'openai-compatible-v1',
          baseUrl,
          location: 'local',
          models: [{ id: 'speech-model', capabilities: ['audio.generate'], input: ['text'] }]
        });
        await expect(new OpenAiCompatibleAdapter().audioGenerate(
          contextFor(provider, provider.models[0]!, new AbortController().signal),
          { text: 'play this aloud' }
        )).rejects.toMatchObject({ code: 'provider_configuration_invalid' });
        expect(requests).toHaveLength(0);
      }
    );
  });
});

describe('video polling adapter over local HTTP', () => {
  it('submits, polls pending states and returns the final observation', async () => {
    let polls = 0;
    await withServer(
      (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.method === 'POST' && request.url === '/video/understand') {
          response.end(JSON.stringify({ id: 'vid-1', status: 'pending' }));
          return;
        }
        if (request.method === 'GET' && request.url === '/video/understand/vid-1') {
          polls += 1;
          if (polls < 3) {
            response.end(JSON.stringify({ status: 'running' }));
            return;
          }
          response.end(
            JSON.stringify({
              status: 'succeeded',
              result: {
                summary: 'a person walks',
                segments: [{ startMs: 0, endMs: 900, text: 'walking' }],
                coverage: 'full video'
              }
            })
          );
          return;
        }
        response.statusCode = 404;
        response.end();
      },
      async (baseUrl, requests) => {
        const provider = videoProvider(baseUrl);
        const progress: string[] = [];
        const result = await new VideoPollingAdapter().videoUnderstand(
          contextFor(provider, provider.models[0]!, new AbortController().signal, 'video-key'),
          videoMedia,
          'summarize',
          undefined,
          (state) => progress.push(state)
        );
        expect(result).toMatchObject({
          summary: 'a person walks',
          segments: [{ startMs: 0, endMs: 900, text: 'walking' }],
          coverage: 'full video'
        });
        expect(progress[0]).toBe('submitted');
        expect(progress).toContain('waiting_remote');
        expect(polls).toBe(3);
        const submit = parseBody(requests.find((request) => request.method === 'POST'));
        expect(submit).toMatchObject({ model: 'local-video-model', prompt: 'summarize' });
        expect(submit.video).toEqual({
          mimeType: 'video/mp4',
          dataBase64: videoMedia.data.toString('base64')
        });
        expect(requests.find((request) => request.method === 'POST')?.authorization).toBe('Bearer video-key');
      }
    );
  });

  it('sends a best-effort remote cancel when the local signal aborts during polling', async () => {
    let deletes = 0;
    await withServer(
      (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.method === 'POST') {
          response.end(JSON.stringify({ id: 'vid-2', status: 'pending' }));
          return;
        }
        if (request.method === 'GET') {
          response.end(JSON.stringify({ status: 'running' }));
          return;
        }
        if (request.method === 'DELETE') {
          deletes += 1;
          response.statusCode = 204;
          response.end();
        }
      },
      async (baseUrl) => {
        const provider = videoProvider(baseUrl);
        const controller = new AbortController();
        const pending = new VideoPollingAdapter().videoUnderstand(
          contextFor(provider, provider.models[0]!, controller.signal),
          videoMedia,
          'summarize'
        );
        setTimeout(() => controller.abort(new JobError('job_cancelled', 'cancelled by test')), 40);
        await expect(pending).rejects.toMatchObject({ code: 'job_cancelled' });
        expect(deletes).toBe(1);
      }
    );
  });
});
