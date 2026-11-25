const test = require('node:test');
const assert = require('node:assert/strict');
const {extensionHandler, allowSlotNavigation} = require('../../electron/extension-protocol.cjs');

test('独立协议只读取声明资源出口并重新签发隔离响应头', async () => {
  const calls = [];
  const handler = extensionHandler('http://127.0.0.1:1234', (url, options) => {
    calls.push({url, options});
    return new Response('page', { headers: { 'content-type':'text/html', 'set-cookie':'private=x' } });
  });
  const get = (url, method = 'GET') => handler({url, method});
  const res = await get('nd-ext://demo/ui/index.html?v=v2');
  assert.equal(await res.text(), 'page');
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  for (const directive of ["connect-src 'none'", "default-src 'none'", "object-src 'none'", "base-uri 'none'"])
    assert.ok(res.headers.get('content-security-policy').includes(directive));
  for (const url of ['nd-ext://demo/v1/roles','nd-ext://demo/ui/%2fprivate','nd-ext://a@demo/ui/x','desk://bundle/ui/x'])
    assert.equal((await get(url)).status, 404);
  assert.equal((await get('nd-ext://demo/ui/x', 'POST')).status, 404);
  assert.deepEqual(calls, [{url:'http://127.0.0.1:1234/v1/extensions/demo/ui/index.html?v=v2',options:{redirect:'manual'}}]);
});

test('子框架导航绑定主窗口及扩展标识', () => {
  const main = {url:'desk://bundle/index.html'};
  const frame = {url:'nd-ext://demo/ui/index.html', parent:main};
  const allowed = (url, initiator) => allowSlotNavigation({frame, url, initiator, isMainFrame:false}, main);
  assert.ok(allowed(frame.url, main));
  assert.ok(allowed('nd-ext://demo/ui/next.html', frame));
  for (const target of ['nd-ext://other/ui/doc','desk://bundle/index.html','http://127.0.0.1/v1/roles'])
    assert.equal(allowed(target, frame), false);
});
