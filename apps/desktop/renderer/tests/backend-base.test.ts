import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendBaseUrl } from '../src/conversation/backend-base';

test('同一在途读取共享，空地址与失败允许重读，只缓存就绪地址', async t => {
  const replies = ['', null, 'http://127.0.0.1:1234/'];
  const fetcher = t.mock.method(globalThis, 'fetch', async () => {
    const base = replies.shift();
    if (base === null) throw Error('offline');
    return Response.json({ backendBaseUrl: base });
  });
  const pending = backendBaseUrl();
  assert.equal(backendBaseUrl(), pending);
  assert.equal(await pending, null);
  assert.equal(await backendBaseUrl(), null);
  assert.equal(await backendBaseUrl(), 'http://127.0.0.1:1234');
  assert.equal(await backendBaseUrl(), 'http://127.0.0.1:1234');
  assert.equal(fetcher.mock.callCount(), 3);
});
