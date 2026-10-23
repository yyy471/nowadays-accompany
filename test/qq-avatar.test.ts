import { describe, expect, it } from 'vitest';
import { QqAvatarCache } from '../src/injection/qq-avatar.js';

function imageResponse(bytes = Buffer.from('fake-jpeg')) {
  return new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });
}

describe('QQ avatar cache', () => {
  it('fetches once and reuses the data URL', async () => {
    let calls = 0;
    const cache = new QqAvatarCache({
      fetchImpl: (async () => {
        calls += 1;
        return imageResponse();
      }) as typeof fetch
    });
    const first = await cache.get('2434944654');
    const second = await cache.get('2434944654');
    expect(first).toBe(`data:image/jpeg;base64,${Buffer.from('fake-jpeg').toString('base64')}`);
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it('only requests numeric QQ accounts', async () => {
    let calls = 0;
    const cache = new QqAvatarCache({
      fetchImpl: (async () => {
        calls += 1;
        return imageResponse();
      }) as typeof fetch
    });
    expect(await cache.get('qq-10001')).toBeUndefined();
    expect(await cache.get('10001')).toBeDefined();
    expect(calls).toBe(1);
  });

  it('returns no avatar for failures and caches the failure briefly', async () => {
    let calls = 0;
    const cache = new QqAvatarCache({
      fetchImpl: (async () => {
        calls += 1;
        return new Response('down', { status: 503 });
      }) as typeof fetch
    });
    expect(await cache.get('10001')).toBeUndefined();
    expect(await cache.get('10001')).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('rejects a non-image response', async () => {
    const cache = new QqAvatarCache({
      fetchImpl: (async () => new Response('<html>nope</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })) as typeof fetch
    });
    expect(await cache.get('10001')).toBeUndefined();
  });
});
