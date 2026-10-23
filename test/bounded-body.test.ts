import { describe, expect, it } from 'vitest';
import {
  HttpBodyError,
  readResponseBytes,
  readResponseText
} from '../src/platform/http/bounded-body.js';

function responseFrom(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Response {
  return new Response(stream, { headers });
}

describe('bounded response body', () => {
  it('reads text and bytes within the limit', async () => {
    const response = responseFrom(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello '));
        controller.enqueue(new TextEncoder().encode('world'));
        controller.close();
      }
    }));
    await expect(readResponseText(response, { maxBytes: 32 })).resolves.toBe('hello world');
  });

  it('cancels the stream before buffering past the limit', async () => {
    let pulls = 0;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        canceled = true;
      }
    });
    await expect(readResponseBytes(responseFrom(stream), { maxBytes: 16 })).rejects.toMatchObject({
      code: 'http_body_too_large',
      limit: 16
    });
    expect(canceled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it('rejects a declared content-length before reading', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        canceled = true;
      }
    });
    await expect(readResponseBytes(responseFrom(stream, { 'content-length': '64' }), { maxBytes: 16 }))
      .rejects.toMatchObject({ code: 'http_body_too_large', bytes: 64 });
    expect(canceled).toBe(true);
  });

  it('times out a slow body and cancels the stream', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
      },
      cancel() {
        canceled = true;
      }
    });
    await expect(readResponseText(responseFrom(stream), { maxBytes: 1024, timeoutMs: 20, label: 'slow' }))
      .rejects.toMatchObject({ code: 'http_body_timeout' });
    expect(canceled).toBe(true);
  });

  it('ends the read when the caller aborts', async () => {
    const controller = new AbortController();
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"partial":'));
      },
      cancel() {
        canceled = true;
      }
    });
    const read = readResponseText(responseFrom(stream), { maxBytes: 1024, signal: controller.signal });
    setTimeout(() => controller.abort(new Error('caller canceled')), 10);
    await expect(read).rejects.toBeInstanceOf(HttpBodyError);
    await expect(read).rejects.toMatchObject({ code: 'http_body_aborted' });
    expect(canceled).toBe(true);
  });

  it('rejects an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const response = responseFrom(new ReadableStream<Uint8Array>({ start() {} }));
    await expect(readResponseText(response, { maxBytes: 32, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'http_body_aborted' });
  });
});
