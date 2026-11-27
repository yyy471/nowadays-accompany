import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { after } from 'node:test';
import { backendReachable } from '../src/components/shell/BackendConnection';
import { remainingThemeTime } from '../src/ui/theme-deadline';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => vite.close());
const { Button, scheduleBusySpinner } = await vite.ssrLoadModule('/src/ui/foundation.tsx');
const { menuKeyIndex, menuPlacement } = await vite.ssrLoadModule('/src/ui/menu.tsx');

test('菜单按真实高度选边，上开相对触发器定位，两侧保留视口边距', () => {
  assert.deepEqual(menuPlacement({ top: 465, bottom: 505 }, { top: 456, bottom: 512 }, 540, 244),
    { top: 'auto', bottom: 55, maxHeight: 420 });
  assert.deepEqual(menuPlacement({ top: 300, bottom: 344 }, { top: 295, bottom: 348 }, 540, 96),
    { top: 57, bottom: 'auto', maxHeight: 172 });
});

test('方向键从菜单容器、首尾及空列表进入时均只定位可用项', () => {
  for (const [key, index, expected] of [
    ['ArrowUp', -1, 2], ['ArrowDown', -1, 0], ['ArrowUp', 0, 2],
    ['ArrowDown', 2, 0], ['Home', 2, 0], ['End', 0, 2],
  ] as const) assert.equal(menuKeyIndex(key, index, 3), expected);
  assert.equal(menuKeyIndex('ArrowUp', -1, 0), undefined);
  assert.equal(menuKeyIndex('ArrowDown', 0, 1), 0);
});

test('Button 首次忙碌即锁定，299ms 内完成不出现 spinner，持续到 300ms 才显示', t => {
  const html = renderToStaticMarkup(createElement(Button, { busy: true }, '保存'));
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /aria-disabled="true"/);
  assert.doesNotMatch(html, /class="spinner"/);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let shown = 0;
  const cancel = scheduleBusySpinner(() => shown++);
  t.mock.timers.tick(299);
  cancel();
  t.mock.timers.tick(1);
  assert.equal(shown, 0);
  scheduleBusySpinner(() => shown++);
  t.mock.timers.tick(299);
  assert.equal(shown, 0);
  t.mock.timers.tick(1);
  assert.equal(shown, 1);
});

test('连接墨点以本次健康请求为准，退出、服务错误和恢复均走真实请求路径', async t => {
  const signal = new AbortController().signal;
  const responses = [Response.json({ status: 'ok' }), Response.json({ connected: true }),
    Response.json({ status: 'ok' }, { status: 503 }), null, Response.json({ status: 'ok' })];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, '/v1/health');
    assert.equal(init.signal, signal);
    const response = responses.shift();
    if (!response) throw new TypeError('Failed to fetch');
    return response;
  });
  for (const expected of [true, false, false, false, true]) assert.equal(await backendReachable(signal), expected);
});

test('准备副本、绘制、排队反切消耗同一点击预算，到期立即清理', () => {
  assert.equal(remainingThemeTime(100, 400, 132), 368);
  assert.equal(remainingThemeTime(100, 550, 620), 30);
  assert.equal(remainingThemeTime(100, 550, 651), 0);
});
