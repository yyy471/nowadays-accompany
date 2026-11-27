import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { parseExtensionSnapshot } from '../src/extensions/use-extensions';

test('旧快照缺失或返回 null 的 tools、ui 均可渲染扩展行', async () => {
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { ExtensionsPage } = await vite.ssrLoadModule('/src/extensions/ExtensionViews.tsx');
    for (const [connection, label] of [['loading', '正在读取'], ['reconnecting', '正在重连'], ['ready', '台面还空着']]) {
      const markup = renderToStaticMarkup(createElement(ExtensionsPage, { state: { connection, items: [] }, roles: [] }));
      assert.ok(markup.includes(label));
      assert.equal(markup.includes('去对话里提一个想法'), connection === 'ready');
    }
    for (const fields of [{}, { tools: null, ui: null }]) {
      const items = parseExtensionSnapshot(JSON.stringify([{ extId: 'legacy', version: 'v1', status: 'enabled', lastError: null, ...fields }]));
      assert.deepEqual([items[0].tools, items[0].ui], [[], []]);
      assert.match(renderToStaticMarkup(createElement(ExtensionsPage, { state: { items, connection: 'ready' }, roles: [] })), /legacy/);
    }
  } finally { await vite.close(); }
});
