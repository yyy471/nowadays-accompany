import assert from 'node:assert/strict';
import test from 'node:test';
import { api, apiBinary, ApiError, apiUpload } from '../src/api';
import { errorText } from '../src/lib/error-text';

test('JSON、上传和二进制请求均将网络失败映射为本地服务不可达', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  for (const request of [api('/v1/roles'), apiUpload('/v1/upload', new FormData()), apiBinary('/v1/audio')]) {
    await assert.rejects(request, { name: 'ApiError', status: 0, code: 'BACKEND_UNREACHABLE', message: '本地服务暂时连不上' });
  }
  assert.equal(errorText(new ApiError('offline', 503, 'BACKEND_OFFLINE')), '本地服务暂时连不上');
});

test('5xx 缺失中文原因时返回通用中文提示并保留机器码和详情', async t => {
  const bodies = ['', JSON.stringify({ error: { code: 'FAIL', message: 'Unavailable', details: { count: 2 } } })];
  t.mock.method(globalThis, 'fetch', async () => new Response(bodies.shift(), { status: 503 }));
  const message = '本地服务出错了，请稍后重试';
  await assert.rejects(api('/v1/roles'), { name: 'ApiError', status: 503, code: null, message });
  await assert.rejects(api('/v1/roles'), { name: 'ApiError', status: 503, code: 'FAIL', message, details: { count: 2 } });
});

test('中文服务错误原样显示', async t => {
  const message = '角色正在保存，请稍后再试。';
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message } }, { status: 503 }));
  await assert.rejects(api('/v1/roles'), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(errorText(error), message);
    return true;
  });
});

test('主动取消的错误保留原对象且不上屏', async t => {
  const aborted = new DOMException('The operation was aborted.', 'AbortError');
  t.mock.method(globalThis, 'fetch', async () => { throw aborted; });
  await assert.rejects(api('/v1/roles'), error => {
    assert.equal(error, aborted);
    assert.equal(errorText(error), '');
    return true;
  });
});

test('读 5xx 响应正文期间取消也不上屏', async t => {
  const aborted = new DOMException('The operation was aborted.', 'AbortError');
  const response = new Response(new ReadableStream({ start(controller) { controller.error(aborted); } }), { status: 503 });
  t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(api('/v1/roles'), error => {
    assert.equal(error, aborted);
    assert.equal(errorText(error), '');
    return true;
  });
});
