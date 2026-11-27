import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendBaseUrl, invalidateBackendBaseUrl } from '../src/conversation/backend-base';

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

test('失效与强制刷新会重新请求地址', async t => {
  invalidateBackendBaseUrl();
  const replies = ['http://127.0.0.1:1111', 'http://127.0.0.1:2222', 'http://127.0.0.1:3333'];
  const fetcher = t.mock.method(globalThis, 'fetch', async () => Response.json({ backendBaseUrl: replies.shift() }));
  assert.equal(await backendBaseUrl(), 'http://127.0.0.1:1111');
  assert.equal(await backendBaseUrl(), 'http://127.0.0.1:1111');
  assert.equal(fetcher.mock.callCount(), 1);
  invalidateBackendBaseUrl();
  assert.equal(await backendBaseUrl(), 'http://127.0.0.1:2222');
  assert.equal(await backendBaseUrl({ refresh: true }), 'http://127.0.0.1:3333');
  assert.equal(fetcher.mock.callCount(), 3);
});
